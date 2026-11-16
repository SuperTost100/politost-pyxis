import { inspectDot, type GraphvizLibrary } from "./inspect-dot";

/**
 * The worker of the drawing window. It runs the downloaded Graphviz and nothing else, in a context of its own: the code
 * of the pack cannot reach the page's sanitiser, its rasteriser or its DOM, and the page takes what comes back from here
 * as text to be cleaned, whatever it says. A drawing is one message in and one message out.
 */
const BASE = "pyxis-runtime://draw/";
type Request = { id: number; code: string; engine: string };
type Reply = { id: number; ok: true; svg: string } | { id: number; ok: false; error: string };

const scope = self as unknown as {
  onmessage: ((event: { data: Request }) => void) | null;
  postMessage: (reply: Reply) => void;
};

let library: Promise<GraphvizLibrary> | undefined;

/** The library is loaded when the first graph is drawn, once for the life of this worker. */
function loadLibrary(): Promise<GraphvizLibrary> {
  library ??= (async () => {
    // The pack's file is served by main after its hash is checked again; this worker asks for nothing else.
    const module = (await import(/* @vite-ignore */ `${BASE}drawing/graphviz.js`)) as {
      Graphviz: { load: () => Promise<GraphvizLibrary> };
    };
    return module.Graphviz.load();
  })();
  return library;
}

scope.onmessage = async ({ data }) => {
  const { id } = data;
  let loaded: GraphvizLibrary;
  try {
    loaded = await loadLibrary();
  } catch {
    // A pack file that would not load (it failed its check when served, or is not there) is no fault of the figure.
    scope.postMessage({ id, ok: false, error: "runtime-draw-library-missing" });
    return;
  }
  try {
    const problem = inspectDot(loaded, data.code);
    if (problem) {
      scope.postMessage({ id, ok: false, error: problem });
      return;
    }
    scope.postMessage({ id, ok: true, svg: loaded.layout(data.code, "svg", data.engine) });
  } catch (error) {
    scope.postMessage({ id, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
  }
};
