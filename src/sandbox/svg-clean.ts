import type { DOMPurify } from "dompurify";

/** The longest SVG text the window will read, in characters. A longer one is refused before it is parsed. */
export const SVG_MAX = 2_000_000;

/**
 * The elements a Graphviz drawing is made of. Everything else is removed after DOMPurify has done its work, so an
 * element nobody thought of cannot get through: links, images, scripts, `use`, `style`, `foreignObject`, animations
 * and filters are not on the list.
 */
const ELEMENTS = new Set([
  "svg", "g", "title", "desc", "defs", "polygon", "polyline", "ellipse", "circle", "path", "line", "rect", "text",
  "tspan", "lineargradient", "radialgradient", "stop", "clippath",
]);

/** What every text of a drawing is set in. The font itself is embedded in the picture by the page (see draw-host.ts). */
export const FONT_FAMILY = "Figtree, sans-serif";

export type CleanSvg = { ok: true; svg: Element; width: number; height: number } | { ok: false; error: string };

const SIZE = /^\s*([0-9]*\.?[0-9]+)\s*(pt|px)?\s*$/;

/** A width or height as CSS pixels. Graphviz writes points. */
function pixels(value: string | null): number | null {
  const match = value ? SIZE.exec(value) : null;
  if (!match) return null;
  const number = Number(match[1]);
  return match[2] === "px" || !match[2] ? number : (number * 4) / 3;
}

/**
 * The SVG Graphviz produced as a tree that is safe to turn into a picture, or why not. DOMPurify (shipped in the app,
 * never in the downloaded pack) removes what it knows is dangerous. Then this keeps only the elements above, drops
 * every attribute that is an event handler, a link or a style, and every value that loads something that is not a
 * fragment of the drawing itself (`url(#id)`).
 */
export function cleanSvg(purify: DOMPurify, text: string): CleanSvg {
  if (text.length > SVG_MAX) return { ok: false, error: "the drawing is too large, make it smaller" };
  // With RETURN_DOM it hands back the <body> the text was parsed into.
  const body = purify.sanitize(text, {
    USE_PROFILES: { svg: true },
    FORBID_TAGS: ["foreignObject", "script", "image", "use", "style", "a", "animate", "set", "animateMotion", "animateTransform"],
    FORBID_ATTR: ["href", "xlink:href", "style"],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM: true,
  }) as HTMLElement;
  const roots = Array.from(body.querySelectorAll("svg")).filter((svg) => svg.parentElement === body);
  const svg = roots[0];
  if (roots.length !== 1 || !svg) return { ok: false, error: "the drawing is not one SVG picture" };
  for (const element of Array.from(svg.querySelectorAll("*")))
    if (!ELEMENTS.has(element.localName.toLowerCase())) element.remove();
  // Graphviz measured the text as Arial; it is drawn in the app's font, whatever name the text gave.
  for (const text of Array.from(svg.querySelectorAll("text, tspan"))) text.setAttribute("font-family", FONT_FAMILY);
  for (const element of [svg, ...Array.from(svg.querySelectorAll("*"))])
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.replace(/[\u0000- ]+/g, "").toLowerCase();
      if (
        name.startsWith("on") ||
        name.endsWith("href") ||
        name === "style" ||
        name === "src" ||
        value.startsWith("javascript:") ||
        value.startsWith("data:") ||
        /url\((?!['"]?#)/.test(value)
      )
        element.removeAttribute(attribute.name);
    }
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const viewBox = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const width = pixels(svg.getAttribute("width")) ?? (viewBox.length === 4 ? viewBox[2]! : NaN);
  const height = pixels(svg.getAttribute("height")) ?? (viewBox.length === 4 ? viewBox[3]! : NaN);
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)))
    return { ok: false, error: "the drawing has no size" };
  return { ok: true, svg, width, height };
}
