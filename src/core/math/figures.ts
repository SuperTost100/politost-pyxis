import { z } from "zod";
import { generate, type GenerateInput } from "../engine/generate";
import { partialText, systemPrompt } from "../engine/prompts";
import {
  FIGURE_KINDS,
  drawableKinds,
  figureKinds,
  figureProblem,
  type FigureKind,
  type PackId,
} from "../../shared/figure-kinds";
import {
  FIGURE_MAX,
  darkFigureKey,
  figureImages,
  figureKey,
  mapFigureBlocks,
  type FigureData,
} from "../../shared/smart-text";
import { darkFigure } from "./dark-figure";
import { drawInWindow } from "./draw";
import { figureProgram } from "./figure-program";
import { runPython, type PythonRun } from "./python";
import { runtimeRequest } from "./runtime-client";

/**
 * Corrects the code of a figure that failed, given the error. Resolves to the new code, or null when there is none, and
 * rejects only when the work was stopped.
 */
export type FigureFix = (
  figure: FigureData,
  error: string,
) => Promise<string | null>;

/**
 * Draws one figure. `code` is what runs: the Python program of a plot or a circuit, or the text itself of a figure that
 * is not Python (a graph's DOT). `figure` says what is being drawn, for a runner that has more than one place to draw.
 */
export type FigureRunner = (
  code: string,
  timeoutMs: number,
  figure?: { kind: FigureKind; code: string },
) => Promise<PythonRun>;

/** The real runner: Python's sandbox for what is Python, the drawing window for the rest. */
export const runFigure: FigureRunner = (code, timeoutMs, figure) =>
  figure && FIGURE_KINDS[figure.kind].renderer === "window"
    ? drawInWindow(figure.kind, figure.code, timeoutMs)
    : runPython(code, timeoutMs);

/** The runner when there is no sandbox: every new figure fails and is left out. */
export const noSandbox: FigureRunner = async () => ({
  stdout: "",
  stderr: "runtime-unavailable",
  images: [],
  timedOut: false,
  truncated: false,
});

/** What draws figures now: the sandbox runner and the kinds it can draw with the packs that are downloaded. */
export type FigureDrawer = { run: FigureRunner; kinds: readonly FigureKind[] };

/**
 * What draws figures, or null when figures are off: the caller's runner when given, which draws every kind, otherwise
 * the real sandbox with the kinds whose packs are downloaded.
 */
export async function figureRunner(
  python?: FigureRunner | null,
): Promise<FigureDrawer | null> {
  if (python !== undefined)
    return python ? { run: python, kinds: figureKinds } : null;
  const kinds = await availableKinds();
  return kinds.length ? { run: runFigure, kinds } : null;
}

/** A kind is offered to the model only when the sandbox can draw it: every pack it needs is downloaded. */
async function availableKinds(): Promise<FigureKind[]> {
  try {
    const status = (await runtimeRequest("status", {}, 5000)) as {
      packs?: Partial<Record<PackId, string>>;
    };
    return drawableKinds((pack) => status.packs?.[pack] === "ready");
  } catch {
    return [];
  }
}

const FIGURE_TAG = /^\[(?:figures|figure:([a-z]+))\] /;

/**
 * The figure instruction of a system text, for the kinds that can be drawn now. The instruction comes from the
 * `figures` partial, whose lines start with a tag: `[figures]` on the shared rules and `[figure:<kind>]` on a kind's
 * line. The lines of kinds that cannot be drawn are left out, the whole instruction is left out when none can, the
 * tags are removed and `[max]` becomes the most figures this text may ask for.
 */
export function figureText(
  text: string,
  kinds: readonly FigureKind[],
  max: number,
): string {
  return text
    .split("\n")
    .flatMap((line) => {
      const tag = FIGURE_TAG.exec(line);
      if (!tag) return [line];
      if (!kinds.length || (tag[1] && !kinds.includes(tag[1] as FigureKind)))
        return [];
      return [line.slice(tag[0].length).replaceAll("[max]", String(max))];
    })
    .join("\n");
}

const figureFixReply = z.object({ code: z.string().trim().min(1) });
/** The longest error the fix call is sent: the end of a Python traceback is the part that names the cause. */
export const FIGURE_ERROR_MAX = 1500;

/** The rules the figures partial gives code of a kind, for the fix call. */
function kindRule(kind: FigureKind): string {
  const tag = `[figure:${kind}] `;
  const line = partialText("figures")
    .split("\n")
    .find((line) => line.startsWith(tag));
  return line ? line.slice(tag.length) : "";
}

/** The end of an error, cut at a line start, so a long traceback keeps the lines that name the cause. */
function errorEnd(error: string): string {
  const text = error.trim();
  if (text.length <= FIGURE_ERROR_MAX) return text;
  const cut = text.slice(-FIGURE_ERROR_MAX);
  const newline = cut.indexOf("\n");
  return newline >= 0 && newline < FIGURE_ERROR_MAX - 1 ? cut.slice(newline + 1) : cut;
}

/**
 * The fix call of a caller: one structured call with the figure's kind, caption, code and error, on the caller's own
 * engine selection, run and signal, so the tokens are counted with the job or the chat that asked and a stop reaches
 * it. It never sees the lesson or the answer the figure belongs to. A call that fails leaves the figure unfixed, unless
 * the work was stopped, which stops it too.
 */
export function figureFixer(
  call: Pick<GenerateInput, "selection" | "run" | "signal" | "usage">,
): FigureFix {
  return async (figure, error) => {
    try {
      const reply = await generate({
        ...call,
        system: `${systemPrompt("figure.fix")}\n${kindRule(figure.figureKind)}`,
        prompt: JSON.stringify({
          kind: figure.figureKind,
          caption: figure.caption,
          code: figure.code,
          error: errorEnd(error),
        }),
        schema: figureFixReply,
        // Code is not prose or LaTeX: the `\n` of a Python string must stay a backslash and an n.
        verbatim: ["code"],
      });
      return (reply.data as z.infer<typeof figureFixReply>).code;
    } catch {
      call.signal?.throwIfAborted();
      return null;
    }
  };
}

type Drawn = { image: string } | { error: string | null };

/**
 * One drawing of a figure. A failure carries the error to hand the model, or null when no new code could help (the
 * runtime was missing or crashed).
 */
async function drawOne(figure: FigureData, python: FigureRunner): Promise<Drawn> {
  const problem = figureProblem(figure.figureKind, figure.code);
  if (problem) return { error: problem };
  const { timeoutMs } = FIGURE_KINDS[figure.figureKind];
  // A graph is drawn from its own text by the drawing window, and the rest from a Python program built around their code.
  const program =
    FIGURE_KINDS[figure.figureKind].renderer === "window" ? figure.code : figureProgram(figure);
  const result = await python(program, timeoutMs, { kind: figure.figureKind, code: figure.code }).catch(() => null);
  if (!result) return { error: null };
  if (result.stderr.startsWith("runtime-")) return { error: null };
  if (result.timedOut)
    return { error: `the code ran longer than ${timeoutMs / 1000} seconds: draw the figure with less work` };
  if (result.truncated) return { error: "the code printed far too much: print nothing" };
  const image = figureImages({ "figure-x": result.images[0] })["figure-x"];
  if (image) return { image };
  return {
    error:
      result.stderr.trim() ||
      "the code ran but drew nothing: it must draw the figure the caption describes",
  };
}

/** A block with its code replaced, as the model writes one. */
function figureBlock(figure: FigureData, code: string): string {
  const kind = figure.figureKind === "plot" ? {} : { kind: figure.figureKind };
  return ["```pyxis-figure", JSON.stringify({ ...kind, caption: figure.caption, code }), "```"].join("\n");
}

/** What a drawing tells the one who asked: a figure's picture the moment it is drawn, or that the figure is left out. */
export type FigureEvent = {
  /** The key of the block as the model wrote it (`figureKey` of its code), which is how the text finds its picture. */
  key: string;
  image: string | null;
  /** The same picture for the dark theme, when it was asked for and could be made. */
  dark?: string;
};

/**
 * Draws the figures a lesson or an answer asks for, one sandbox run each, and removes every figure block that did not
 * give an image, so the rest of the text is saved as written. A block is removed when its kind is not in `kinds`
 * (nothing here could draw it, so nobody is asked about it), when it is past the first FIGURE_MAX, or when it fails
 * twice. A figure that fails (code past its kind's limits, code that raised, timed out or drew nothing) is sent to
 * `fix` once with the error, and drawn again with the code it returns. The block then carries the corrected code, which
 * is the code its image is stored for. `known` holds images already drawn for the same kind and code, which are kept
 * without running it again. `kinds` are the kinds the runner can draw: every kind when left out.
 *
 * The figures are drawn together, each as soon as it can be and none waiting for another, so a figure that is being
 * corrected does not hold back the ones that are fine. `onFigure` hears each figure as it is settled: its picture under
 * the key of its block as written, or `null` when it is left out. When `signal` ends the work it does not wait for what
 * is still going: it returns what was drawn so far, with `stopped` set, the blocks of the figures still in progress
 * removed, and tells nothing more.
 */
export async function drawFigures(
  markdown: string,
  options: {
    python?: FigureRunner;
    kinds?: readonly FigureKind[];
    fix?: FigureFix;
    known?: Record<string, string>;
    signal?: AbortSignal;
    onFigure?: (event: FigureEvent) => void;
    /** Also keep each new picture as the dark theme shows it, under the figure's key with `-dark` (`darkFigureKey`). */
    dark?: boolean;
  } = {},
): Promise<{ markdown: string; figures: Record<string, string>; stopped?: true }> {
  const python = options.python ?? runFigure;
  const kinds = options.kinds ?? figureKinds;
  const known = figureImages(options.known);
  const requested: FigureData[] = [];
  mapFigureBlocks(markdown, (figure) => {
    if (figure) requested.push(figure);
    return null;
  });
  const figures: Record<string, string> = {};
  /** By the key of the code as written: the code that was drawn, or null when the figure is left out. */
  const settled = new Map<string, string | null>();
  /** Set when the result is handed back, so work still in the air changes nothing and tells nothing. */
  let closed = false;
  const tell = (event: FigureEvent) => {
    // Nothing is told after the result is handed back, or once the work is stopped.
    if (!closed && !options.signal?.aborted) options.onFigure?.(event);
  };
  const work: Array<Promise<void>> = [];
  async function draw(figure: FigureData, asked: string): Promise<void> {
    if (!kinds.includes(figure.figureKind)) return tell({ key: asked, image: null });
    let code = figure.code;
    let drawn = await drawOne(figure, python);
    if (!("image" in drawn) && drawn.error !== null && options.fix) {
      // Stopped while it was drawn: a correction is a call to the AI tool, and nobody is waiting for it.
      if (closed || options.signal?.aborted) return;
      const fixed = await options.fix(figure, drawn.error);
      // Stopped while the fix was out: the corrected code is not drawn.
      if (closed || options.signal?.aborted) return;
      if (fixed?.trim() && fixed.trim() !== figure.code) {
        code = fixed.trim();
        drawn = await drawOne({ ...figure, code }, python);
      }
    }
    if (closed) return;
    if ("image" in drawn) {
      const key = figureKey(code, figure.figureKind);
      figures[key] = drawn.image;
      const dark = options.dark ? darkFigure(drawn.image) : null;
      if (dark) figures[darkFigureKey(key)] = dark;
      settled.set(asked, code);
      tell({ key: asked, image: drawn.image, ...(dark ? { dark } : {}) });
    } else tell({ key: asked, image: null });
  }
  const signal = options.signal;
  let onAbort = () => {};
  let stopped: boolean;
  // One guard for the whole function: however it ends, the loop included (a callback that throws there leaves work
  // already started), work still in the air tells nobody and changes nothing, and the signal is let go.
  try {
    /** The blocks past the limit, which are removed and told as left out once each. */
    const overLimit = new Set<string>();
    for (const figure of requested) {
      const asked = figureKey(figure.code, figure.figureKind);
      if (settled.has(asked) || overLimit.has(asked)) continue;
      if (settled.size === FIGURE_MAX) {
        overLimit.add(asked);
        tell({ key: asked, image: null });
        continue;
      }
      settled.set(asked, null);
      // A figure that already has its picture keeps it, stopped or not.
      if (known[asked]) {
        figures[asked] = known[asked];
        // Its dark picture is kept when it has one; a picture stored before there were dark ones stays as it is.
        const keptDark = known[darkFigureKey(asked)];
        if (keptDark) figures[darkFigureKey(asked)] = keptDark;
        settled.set(asked, figure.code);
        tell({ key: asked, image: known[asked], ...(keptDark ? { dark: keptDark } : {}) });
        continue;
      }
      // Work that was stopped before it began is not started.
      if (!options.signal?.aborted) work.push(draw(figure, asked));
    }
    const stop = new Promise<void>((resolve) => {
      onAbort = resolve;
      if (signal?.aborted) resolve();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    // A figure's work ends in a stop when the fix call it waits on is stopped; any other failure is not ours to hide.
    const done = Promise.all(
      work.map((task) =>
        task.catch((error: unknown) => {
          if (!signal?.aborted) throw error;
        }),
      ),
    );
    stopped = await Promise.race([done.then(() => false), stop.then(() => true)]);
  } finally {
    closed = true;
    signal?.removeEventListener("abort", onAbort);
    // Work started before a throw in the loop has no handler yet, and its failure is not ours to report once we have rejected.
    for (const task of work) task.catch(() => undefined);
  }
  const result = {
    markdown: mapFigureBlocks(markdown, (figure) => {
      if (!figure) return "";
      const code = settled.get(figureKey(figure.code, figure.figureKind));
      if (code == null) return "";
      return code === figure.code ? null : figureBlock(figure, code);
    }),
    figures,
  };
  return stopped || signal?.aborted ? { ...result, stopped: true } : result;
}

/** A figure as plain text, for the model's view of earlier turns, search and exports. */
export function figureCaptions(markdown: string, label?: string): string {
  return mapFigureBlocks(markdown, (figure) =>
    figure ? `*${label ? `${label}: ` : ""}${figure.caption}*` : "",
  );
}
