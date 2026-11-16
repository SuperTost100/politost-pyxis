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
  figureImages,
  figureKey,
  mapFigureBlocks,
  type FigureData,
} from "../../shared/smart-text";
import { drawInWindow } from "./draw";
import { runPython, type PythonRun } from "./python";
import { runtimeRequest } from "./runtime-client";

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

/**
 * The model's code between a fixed prologue and the `plt.show()` that hands the open figure to the sandbox. A circuit
 * adds its elements to the drawing `d`, which is drawn after the code in dark ink at a size that reads in a lesson.
 * schemdraw sizes the figure to the circuit, and the tight box keeps a label that reaches past it.
 */
export function figureProgram(figure: FigureData): string {
  if (figure.figureKind === "circuit")
    return [
      "import matplotlib",
      "matplotlib.use('Agg')",
      "import matplotlib.pyplot as plt",
      "plt.close('all')",
      "plt.rcParams.update({'savefig.bbox': 'tight', 'savefig.pad_inches': 0.15})",
      "import schemdraw",
      "import schemdraw.elements as elm",
      "schemdraw.use('matplotlib')",
      "d = schemdraw.Drawing(show=False)",
      "d.config(inches_per_unit=0.8, fontsize=12, lw=1.8, color='#15181e')",
      figure.code,
      "if d.elements:",
      "    d.draw(show=False).getfig()",
      "plt.show()",
    ].join("\n");
  return [
    "import matplotlib",
    "matplotlib.use('Agg')",
    "import matplotlib.pyplot as plt",
    "import numpy as np",
    "plt.close('all')",
    "plt.rcParams.update({'figure.figsize': (6.4, 4.0), 'font.size': 11, 'axes.grid': True, 'grid.alpha': 0.3})",
    figure.code,
    "plt.show()",
  ].join("\n");
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

/**
 * Draws the figures a lesson or an answer asks for, one sandbox run each, and removes every figure block that did not
 * give an image (a kind not in `kinds`, code past its kind's limits, code that failed, timed out or drew nothing, or
 * past the first FIGURE_MAX), so the rest of the text is saved as written. `known` holds images already drawn for the
 * same kind and code, which are kept without running it again. `kinds` are the kinds the runner can draw: every kind
 * when left out.
 */
export async function drawFigures(
  markdown: string,
  options: {
    python?: FigureRunner;
    kinds?: readonly FigureKind[];
    known?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<{ markdown: string; figures: Record<string, string> }> {
  const python = options.python ?? runFigure;
  const kinds = options.kinds ?? figureKinds;
  const known = figureImages(options.known);
  const requested: FigureData[] = [];
  mapFigureBlocks(markdown, (figure) => {
    if (figure) requested.push(figure);
    return null;
  });
  const figures: Record<string, string> = {};
  const tried = new Set<string>();
  for (const figure of requested) {
    const key = figureKey(figure.code, figure.figureKind);
    if (tried.has(key)) continue;
    if (tried.size === FIGURE_MAX) break;
    tried.add(key);
    options.signal?.throwIfAborted();
    if (known[key]) {
      figures[key] = known[key];
      continue;
    }
    if (
      !kinds.includes(figure.figureKind) ||
      figureProblem(figure.figureKind, figure.code)
    )
      continue;
    // A graph is drawn from its own text, and the rest from a Python program built around their code.
    const program =
      FIGURE_KINDS[figure.figureKind].renderer === "window" ? figure.code : figureProgram(figure);
    const result = await python(program, FIGURE_KINDS[figure.figureKind].timeoutMs, {
      kind: figure.figureKind,
      code: figure.code,
    }).catch(() => null);
    const image =
      result && !result.timedOut && !result.truncated
        ? result.images[0]
        : undefined;
    const valid = figureImages({ [key]: image })[key];
    if (valid) figures[key] = valid;
  }
  options.signal?.throwIfAborted();
  return {
    markdown: mapFigureBlocks(markdown, (figure) =>
      figure && figures[figureKey(figure.code, figure.figureKind)] ? null : "",
    ),
    figures,
  };
}

/** A figure as plain text, for the model's view of earlier turns, search and exports. */
export function figureCaptions(markdown: string, label?: string): string {
  return mapFigureBlocks(markdown, (figure) =>
    figure ? `*${label ? `${label}: ` : ""}${figure.caption}*` : "",
  );
}
