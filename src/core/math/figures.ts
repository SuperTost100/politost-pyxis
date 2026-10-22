import {
  FIGURE_MAX,
  figureImages,
  figureKey,
  mapFigureBlocks,
  type FigureData,
} from "../../shared/smart-text";
import { runPython, type PythonRun } from "./python";
import { runtimeRequest } from "./runtime-client";

/** Run time of one figure's code. The sandbox caps a run at 10 s; a figure that needs longer is left out. */
export const FIGURE_TIMEOUT_MS = 8000;

export type FigureRunner = (
  code: string,
  timeoutMs: number,
) => Promise<PythonRun>;

/** The runner when there is no sandbox: every new figure fails and is left out. */
export const noSandbox: FigureRunner = async () => ({
  stdout: "",
  stderr: "runtime-unavailable",
  images: [],
  timedOut: false,
  truncated: false,
});

/**
 * The sandbox runner to use, or null when figures are off: the caller's runner when given, otherwise the real sandbox
 * once its runtime is downloaded.
 */
export async function figureRunner(
  python?: FigureRunner | null,
): Promise<FigureRunner | null> {
  if (python !== undefined) return python;
  return (await figuresAvailable()) ? runPython : null;
}

/** Figures are offered to the model only when the sandbox can draw them: the Python runtime is downloaded. */
async function figuresAvailable(): Promise<boolean> {
  try {
    const status = (await runtimeRequest("status", {}, 5000)) as {
      phase?: string;
    };
    return status.phase === "ready";
  } catch {
    return false;
  }
}

/** The model's code between a fixed prologue and the `plt.show()` that hands the open figure to the sandbox. */
function figureProgram(code: string): string {
  return [
    "import matplotlib",
    "matplotlib.use('Agg')",
    "import matplotlib.pyplot as plt",
    "import numpy as np",
    "plt.close('all')",
    "plt.rcParams.update({'figure.figsize': (6.4, 4.0), 'font.size': 11, 'axes.grid': True, 'grid.alpha': 0.3})",
    code,
    "plt.show()",
  ].join("\n");
}

/**
 * Draws the figures a lesson or an answer asks for, one sandbox run each, and removes every figure block that did not
 * give an image (code that failed, timed out, drew nothing, or past the first FIGURE_MAX), so the rest of the text is
 * saved as written. `known` holds images already drawn for the same code, which are kept without running it again.
 */
export async function drawFigures(
  markdown: string,
  options: {
    python?: FigureRunner;
    known?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<{ markdown: string; figures: Record<string, string> }> {
  const python = options.python ?? runPython;
  const known = figureImages(options.known);
  const requested: FigureData[] = [];
  mapFigureBlocks(markdown, (figure) => {
    if (figure) requested.push(figure);
    return null;
  });
  const figures: Record<string, string> = {};
  const tried = new Set<string>();
  for (const figure of requested) {
    const key = figureKey(figure.code);
    if (tried.has(key)) continue;
    if (tried.size === FIGURE_MAX) break;
    tried.add(key);
    options.signal?.throwIfAborted();
    if (known[key]) {
      figures[key] = known[key];
      continue;
    }
    const result = await python(
      figureProgram(figure.code),
      FIGURE_TIMEOUT_MS,
    ).catch(() => null);
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
      figure && figures[figureKey(figure.code)] ? null : "",
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
