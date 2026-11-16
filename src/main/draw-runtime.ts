import { randomUUID } from "node:crypto";
import { app, BrowserWindow, session, type Session } from "electron";
import { z } from "zod";
import { styledDot } from "../shared/dot";
import { FIGURE_KINDS, figureProblem, graphLayout } from "../shared/figure-kinds";
import { FIGURE_IMAGE_MAX } from "../shared/smart-text";
import { requireRuntime } from "./runtime-pack";
import { registerRuntimeProtocol, runtimeOrigin, runtimeResourceName } from "./runtime-protocol";
import { lockSession, lockWindow, rendererGone } from "./runtime-window";

/**
 * The drawing window: a hidden window that draws the figures that are not Python (today graphs, with Graphviz) and
 * hands back a picture. It runs text that came from an AI or from an imported plan file, through libraries from the
 * downloaded pack, so everything about it assumes the page can be hostile:
 *
 * - A fresh partition per window that keeps nothing (no `persist:`), a sandboxed renderer without Node, context
 *   isolation and no preload. The page is its own script (`draw-host.js`, bundled with the app), and main talks to it
 *   with one `executeJavaScript` call and reads one value back.
 * - The session refuses every request that is not one of this window's own files, whatever the page or its CSP says,
 *   and refuses permissions and downloads. The window refuses navigation and new windows.
 * - The value that comes back is validated here. Only a PNG data URL of bounded size and size in pixels is accepted,
 *   or a failure with a short plain message. Nothing from the page is shown as it is, and nothing from it is run.
 * - One drawing at a time. Each has a time limit, and the window's memory is read while it runs. A drawing that goes
 *   over either destroys the window, since JavaScript that runs has no other way to be stopped, and the next
 *   request opens a new one. A crashed window is replaced the same way.
 */
const ORIGIN = runtimeOrigin("draw");
/** The window must have loaded its page by then. */
export const LOAD_CEILING_MS = 20_000;
/** The working set, in KB, over which a drawing is stopped. */
export const MEMORY_LIMIT_KB = 512 * 1024;
export const MEMORY_POLL_MS = 250;
/** The longest side of a picture that is accepted, in pixels, and the size of its smallest. */
export const IMAGE_SIDE_MAX = 2000;

const requestSchema = z.object({
  kind: z.enum(["graph"]),
  code: z.string().min(1),
  timeoutMs: z.number().finite().optional(),
});

/** What a request gives back: a picture, or why there is none. An `error` that starts with `runtime-` is no fault of the figure. */
export type DrawResult = { image: string } | { error: string; timedOut?: boolean };

let workspace = "";
let window: BrowserWindow | null = null;
let opening: Promise<BrowserWindow> | null = null;
let generation = 0;
let tail: Promise<unknown> = Promise.resolve();

export function configureDrawRuntime(path: string): void {
  if (workspace !== path) {
    disposeDrawRuntime();
    workspace = path;
  }
}

export function disposeDrawRuntime(): void {
  generation++;
  window?.destroy();
  window = null;
  opening = null;
}

function destroy(target: BrowserWindow): void {
  if (window === target) {
    window = null;
    opening = null;
  }
  if (!target.isDestroyed()) target.destroy();
}

/** How the window is made. There is no preload: the page is its own script and main reads one value back. */
export function windowPreferences(partition: Session) {
  return {
    session: partition,
    sandbox: true,
    nodeIntegration: false,
    contextIsolation: true,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
    devTools: false,
    spellcheck: false,
    enableWebSQL: false,
    navigateOnDragDrop: false,
    disableDialogs: true,
    // A hidden window would slow its timers, and a drawing has a clock.
    backgroundThrottling: false,
  };
}

async function openWindow(): Promise<BrowserWindow> {
  if (!workspace) throw new Error("runtime-workspace-missing");
  const epoch = generation;
  const path = workspace;
  // Drawing never downloads; the explicit runtime job does that.
  await requireRuntime(path, "drawing");
  if (epoch !== generation) throw new Error("runtime-disposed");
  if (opening) return opening;
  if (window && !window.isDestroyed() && !rendererGone(window)) return window;
  opening = (async () => {
    // No `persist:` prefix and no cache: the partition lives in memory and goes with the window.
    const partition = session.fromPartition(`pyxis-draw-${randomUUID()}`, { cache: false });
    registerRuntimeProtocol(partition, path);
    lockSession(partition, (url) => Boolean(runtimeResourceName(url, "draw")));
    const created = new BrowserWindow({ show: false, webPreferences: windowPreferences(partition) });
    window = created;
    lockWindow(created);
    const forget = () => {
      if (window === created) {
        window = null;
        opening = null;
      }
    };
    created.on("closed", forget);
    // A crashed renderer is replaced by a fresh window on the next request.
    created.webContents.on("render-process-gone", () => {
      forget();
      if (!created.isDestroyed()) created.destroy();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        created.loadURL(ORIGIN + "index.html"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("runtime-draw-load-timeout")), LOAD_CEILING_MS);
        }),
      ]);
      if (epoch !== generation || created.isDestroyed()) throw new Error("runtime-disposed");
      return created;
    } catch (error) {
      destroy(created);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();
  return opening;
}

const PNG_URL = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The picture a window gave back as a PNG data URL, or null. It is one only when it is a data URL of a PNG within the
 * size a stored figure may have, whose bytes start with the PNG signature and a header of a size in pixels that makes
 * sense. Anything else, an SVG or markup included, is not a picture.
 */
export function checkPng(value: unknown): string | null {
  if (typeof value !== "string" || value.length > FIGURE_IMAGE_MAX) return null;
  const match = PNG_URL.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[1]!, "base64");
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > IMAGE_SIDE_MAX || height > IMAGE_SIDE_MAX) return null;
  return value;
}

/** A failure message from the page, as plain text of a bounded length: it is told to a model, never shown as markup. */
function plainMessage(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  // eslint-disable-next-line no-control-regex -- control characters are what this removes
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500);
  return clean || "the drawing failed";
}

/** What the page's one answer means. Whatever its shape, only a checked picture or a short failure comes out. */
export function readAnswer(value: unknown): DrawResult {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const answer = value as { ok?: unknown; png?: unknown; error?: unknown };
    if (answer.ok === true) {
      const image = checkPng(answer.png);
      return image
        ? { image }
        : { error: "the drawing did not come back as a picture, or it is too large: make the graph smaller" };
    }
    if (answer.ok === false) return { error: plainMessage(answer.error) };
  }
  return { error: "runtime-draw-answer-invalid" };
}

function workingSetKb(target: BrowserWindow): number {
  const pid = target.webContents.getOSProcessId();
  return app.getAppMetrics().find((metric) => metric.pid === pid)?.memory.workingSetSize ?? 0;
}

type PageRequest = { kind: "graph"; code: string; engine: string; timeoutMs: number };

async function dispatch(request: PageRequest): Promise<DrawResult> {
  const target = await openWindow();
  if (target.isDestroyed()) throw new Error("runtime-draw-crashed");
  return new Promise<DrawResult>((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const finish = (result: DrawResult, stop = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(poll);
      target.removeListener("closed", crashed);
      if (stop) destroy(target);
      resolve(result);
    };
    const crashed = () => finish({ error: "runtime-draw-crashed" });
    target.once("closed", crashed);
    timer = setTimeout(
      () =>
        finish(
          {
            error: `the drawing ran longer than ${request.timeoutMs / 1000} seconds: draw fewer nodes and edges`,
            timedOut: true,
          },
          true,
        ),
      request.timeoutMs,
    );
    poll = setInterval(() => {
      try {
        if (workingSetKb(target) > MEMORY_LIMIT_KB)
          finish({ error: "the drawing used too much memory: draw fewer nodes and edges" }, true);
      } catch {
        // No reading this time; the next one tries again, and the time limit still holds.
      }
    }, MEMORY_POLL_MS);
    target.webContents
      .executeJavaScript(`window.pyxisDraw.draw(${JSON.stringify(request)})`)
      .then(
        (answer: unknown) => {
          const result = readAnswer(answer);
          // A window that could not load its library would not try again: the next request gets a new one.
          finish(result, "error" in result && result.error === "runtime-draw-library-missing");
        },
        // Since Electron 45 a renderer that dies rejects the pending call at once, before the window closes.
        () =>
          finish({ error: rendererGone(target) ? "runtime-draw-crashed" : "runtime-draw-failed" }),
      );
  });
}

/**
 * One request at a time, so a drawing's clock starts when it runs and its stop reaches only it. A request waiting its
 * turn is dropped, not run, when the runtime was disposed since it was queued (backup, restore, move, wipe, quit) or
 * when its requester's `deadline` has passed.
 */
function execute(request: PageRequest, deadline?: number): Promise<DrawResult> {
  const epoch = generation;
  const turn = tail.then(() => {
    if (epoch !== generation) throw new Error("runtime-disposed");
    if (deadline !== undefined && Date.now() >= deadline) throw new Error("runtime-expired");
    return dispatch(request);
  });
  tail = turn.catch(() => undefined);
  return turn;
}

/**
 * Draws one figure. `code` is checked here again, as core checked it (a request does not have to come from core), and
 * the drawing is given the layout engine the text asks for. `unchecked` skips only that check, for the test that has to
 * show what the window does with text the check would have refused.
 */
export async function handleDrawRequest(
  payload: unknown,
  deadline?: number,
  options: { unchecked?: boolean } = {},
): Promise<DrawResult> {
  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) return { error: "runtime-draw-input-invalid" };
  const { kind, code } = parsed.data;
  const rules = FIGURE_KINDS[kind];
  if (!options.unchecked) {
    const problem = figureProblem(kind, code);
    if (problem) return { error: problem };
  }
  // The clock never runs longer than the kind's limit, whatever a request asks for.
  const timeoutMs = Math.max(50, Math.min(rules.timeoutMs, parsed.data.timeoutMs ?? rules.timeoutMs));
  try {
    return await execute({ kind, code: styledDot(code), engine: graphLayout(code) ?? "dot", timeoutMs }, deadline);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return { error: message.startsWith("runtime-") ? message : "runtime-draw-failed" };
  }
}

/** The drawing windows that are open, for the end-to-end tests. */
function openWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (candidate) => !candidate.isDestroyed() && candidate.webContents.getURL().startsWith(ORIGIN),
  );
}

/**
 * A handle for the end-to-end tests, which they reach through `app.evaluate`. `draw` is the request main answers for
 * core, `drawUnchecked` skips the check of the text so a test can feed the window what the check refuses, and `windows`
 * gives the open drawing windows. Only a run started with PYXIS_E2E=1 (see `e2eSeam` in index.ts) installs it.
 */
export function drawTestHandle() {
  return {
    draw: (payload: unknown) => handleDrawRequest(payload),
    drawUnchecked: (payload: unknown) => handleDrawRequest(payload, undefined, { unchecked: true }),
    windows: () => openWindows().map((candidate) => candidate.id),
    /** The preferences the window is made with, without the session object. */
    preferences: () => {
      const { session: _session, ...rest } = windowPreferences(session.defaultSession);
      void _session;
      return rest;
    },
    /** Runs a script in a drawing window, as a hostile page would. */
    evaluate: (script: string) => {
      const [target] = openWindows();
      if (!target) throw new Error("no drawing window is open");
      return target.webContents.executeJavaScript(script);
    },
  };
}
