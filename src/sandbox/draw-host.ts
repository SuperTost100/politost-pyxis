import DOMPurify from "dompurify";
// The app's own text font, as a data URL inside this script: it comes from the app, not from the pack or the network.
import figtree from "../renderer/src/design-system/fonts/Figtree-Variable.woff2?inline";
import { cleanSvg } from "./svg-clean";

/**
 * The page of the drawing window (see main/draw-runtime.ts). It draws one figure at a time and answers with one value,
 * `{ok: true, png}` or `{ok: false, error}`, which main checks again.
 *
 * What runs where: Graphviz, which comes from the downloaded pack and reads text from an AI, runs in a worker of its own
 * (draw-worker.ts), where it has no DOM and shares nothing with this page. This page, the app's own script, holds the
 * sanitiser, the font and the rasterising, and treats what the worker sends as text to be cleaned: a worker that were
 * tampered with could send any text, and the cleaning, the size checks and main's check of the picture are what stand
 * after it. The window has no network (the session refuses it, and sends the network stack's own work to a proxy that is
 * not there) and no way to run a string.
 */
const BASE = "pyxis-runtime://draw/";
/**
 * The longest side of the picture, in pixels, and the longest a stored picture may be as a data URL. A drawing is
 * rasterised at 120 pixels to the inch, as the plots and circuits are, so its text and lines are the size theirs are.
 */
const SIDE_MAX = 2000;
/** 120 pixels to the inch against the 96 a point is drawn at (see `pixels` in svg-clean.ts). */
const DENSITY = 120 / 96;
const IMAGE_MAX = 700_000;
/** A picture is an SVG shown as an image, which loads no font of the page: the font is part of the SVG. */
const FONT_FACE = `@font-face { font-family: "Figtree"; src: url(${figtree}) format("woff2"); font-weight: 300 900; font-style: normal; }`;
const ENGINES = ["dot", "neato", "circo", "fdp", "twopi"];

type Answer = { ok: true; png: string } | { ok: false; error: string };
type Laid = { ok: true; svg: string } | { ok: false; error: string };

let worker: Worker | undefined;
let counter = 0;

/**
 * Graphviz runs in a worker of its own, the one file `worker-src` allows, so the code of the pack shares nothing with this
 * page: not the sanitiser, not the canvas, not the DOM. What it sends back is text and is read as text. A worker that
 * failed is ended and the next drawing gets a new one, with a new instance of the library.
 */
function layout(code: string, engine: string): Promise<Laid> {
  worker ??= new Worker(`${BASE}draw-worker.js`);
  const running = worker;
  const id = ++counter;
  const end = (reply: Laid): Laid => {
    running.onmessage = null;
    running.onerror = null;
    if (!reply.ok && worker === running) {
      running.terminate();
      worker = undefined;
    }
    return reply;
  };
  return new Promise<Laid>((resolve) => {
    running.onmessage = (event: MessageEvent) => {
      const data = event.data as { id?: unknown; ok?: unknown; svg?: unknown; error?: unknown } | null;
      if (data?.id !== id) return;
      if (data.ok === true && typeof data.svg === "string") resolve(end({ ok: true, svg: data.svg }));
      else resolve(end({ ok: false, error: typeof data.error === "string" ? data.error.slice(0, 500) : "runtime-draw-failed" }));
    };
    running.onerror = () => resolve(end({ ok: false, error: "runtime-draw-failed" }));
    running.postMessage({ id, code, engine });
  });
}

function fail(error: unknown): Answer {
  const text = error instanceof Error ? error.message : String(error);
  return { ok: false, error: text.slice(0, 500) };
}

async function rasterise(svg: string, width: number, height: number, scale: number): Promise<string> {
  const fit = Math.min(scale, SIDE_MAX / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * fit));
  canvas.height = Math.max(1, Math.round(height * fit));
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const context = canvas.getContext("2d");
    if (!context) throw new Error("the picture could not be made");
    const paint = () => {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
    };
    // The picture's font loads from its own data URL while it is decoded and first drawn. The second drawing, one
    // frame later, is the one that is kept, so the text is never the fallback font.
    paint();
    await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));
    paint();
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** An SVG text cleaned and written out again, or why it cannot be. */
function clean(text: string): { ok: true; svg: string } | { ok: false; error: string } {
  try {
    const cleaned = cleanSvg(DOMPurify, text);
    return cleaned.ok
      ? { ok: true, svg: new XMLSerializer().serializeToString(cleaned.svg) }
      : { ok: false, error: cleaned.error };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** An SVG text as a PNG: cleaned, drawn on a white ground at twice its size, and drawn again smaller if it is too big. */
async function fromSvg(text: string): Promise<Answer> {
  try {
    const cleaned = cleanSvg(DOMPurify, text);
    if (!cleaned.ok) return { ok: false, error: cleaned.error };
    // The font is added after the cleaning, which removes every `style` of the text it is given.
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = FONT_FACE;
    cleaned.svg.insertBefore(style, cleaned.svg.firstChild);
    const svg = new XMLSerializer().serializeToString(cleaned.svg);
    for (const scale of [DENSITY, 1]) {
      const png = await rasterise(svg, cleaned.width, cleaned.height, scale);
      if (png.length <= IMAGE_MAX) return { ok: true, png };
    }
    return { ok: false, error: "the drawing is too large, make it smaller" };
  } catch (error) {
    return fail(error);
  }
}

async function draw(request: { kind: string; code: string; engine: string }): Promise<Answer> {
  try {
    if (request.kind !== "graph") return { ok: false, error: "this window does not draw that kind" };
    // The text, with the look every graph starts from put in front (see styledDot in shared/dot.ts).
    if (typeof request.code !== "string" || request.code.length > 8000) return { ok: false, error: "the code is too long" };
    if (!ENGINES.includes(request.engine)) return { ok: false, error: "that layout is not allowed" };
    // A pack file that would not load comes back as `runtime-draw-library-missing`, which main reads as no fault of the
    // figure and replaces this window for, since it would not try that file again.
    const laid = await layout(request.code, request.engine);
    return laid.ok ? await fromSvg(laid.svg) : { ok: false, error: laid.error };
  } catch (error) {
    return fail(error);
  }
}

// `clean` and `fromSvg` are what `draw` is made of; the end-to-end tests call them with hostile SVG text of their own.
Object.defineProperty(window, "pyxisDraw", { value: Object.freeze({ draw, fromSvg, clean }) });
