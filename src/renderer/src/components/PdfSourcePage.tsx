import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist";
import { invoke } from "../lib/ipc";
import { Logo } from "./Logo";
import { citedRuns, keepPages, keepPicture, loadingSlot, pdfFailure, readRange } from "./sourcePanel";

/** pdf.js asks for the file in chunks of this size, and only for the chunks the page it draws needs. */
const CHUNK = 64 * 1024;
/** A short wait shows nothing; a longer one shows the page being prepared, so a fast page never flashes it. */
const SHOW_WORK_AFTER = 150;

export type PdfOutcome = { count: number } | { error: "locked" | "missing" | "failed"; detail?: string };

/** Where the cited passage sits on the drawn page, in the page's own pixels, for the mark in its margin. */
type Mark = { top: number; height: number; left: number };

const loadPdfjs = () => import("pdfjs-dist/legacy/build/pdf.mjs");

/**
 * One page of a PDF in the Library, drawn from the original: the picture on a canvas, the text in an invisible layer
 * over it (selectable and read by screen readers), and a mark in the margin beside the cited passage. The file is read
 * through core a chunk at a time (`sources.readOriginal`), so a 900-page book opens at page 412 having read the chunks
 * that page needs, not the book. Pages seen last stay drawn, three at most (`keepPages`); the rest are let go.
 */
export default function PdfSourcePage({
  where,
  page,
  excerpt,
  citedPage,
  onOutcome,
  onScan,
  onMarked,
}: {
  where: { sourceId?: string; passageId?: string };
  page: number;
  /** The cited passage, marked on `citedPage` only. */
  excerpt: string | null;
  citedPage: number | null;
  onOutcome: (outcome: PdfOutcome) => void;
  /** The page has no text of its own: a scan, whose read text the panel shows under it. */
  onScan: (scan: boolean) => void;
  /** Whether the cited passage was found on the drawn page. */
  onMarked: (found: boolean) => void;
}) {
  const { t } = useTranslation();
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [drawn, setDrawn] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const [mark, setMark] = useState<Mark | null>(null);
  const [ratio, setRatio] = useState(1.414);
  const [width, setWidth] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const read = useRef(0);
  // A read failed and the document was destroyed: what the page was drawing fails too, and says nothing more.
  const broken = useRef(false);
  // The pages kept drawn, most recent first, and their pictures at the width they were drawn.
  const kept = useRef<number[]>([]);
  const pictures = useRef(new Map<string, ImageBitmap>());
  const report = useRef({ onOutcome, onScan, onMarked });
  report.current = { onOutcome, onScan, onMarked };
  const sourceId = where.sourceId;
  const passageId = where.passageId;

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.floor(element.clientWidth)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const slot = loadingSlot();
    const ask = { sourceId, passageId };
    read.current = 0;
    broken.current = false;
    setPdf(null);
    const count = (bytes: number) => {
      read.current += bytes;
      box.current?.setAttribute("data-bytes-read", String(read.current));
    };
    // pdf.js can't hear that a range failed, so a failed read is reported here, once, and the loading task is destroyed
    // with what it loaded. The page then shows the missing or failed state instead of waiting for bytes that won't come.
    const fail = (err: unknown) => {
      if (!slot.fail()) return;
      broken.current = true;
      report.current.onOutcome(pdfFailure(err));
    };
    const readOriginal = (start: number, length: number) =>
      invoke("sources.readOriginal", { ...ask, start, length }).then((chunk) => {
        count(chunk.bytes.length);
        return chunk;
      });
    void (async () => {
      const pdfjs = await loadPdfjs();
      const first = await readOriginal(0, CHUNK);
      if (slot.closed) return;
      const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs?url");
      if (slot.closed) return;
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      class CoreRange extends pdfjs.PDFDataRangeTransport {
        override requestDataRange(begin: number, end: number) {
          void readRange(readOriginal, begin, end).then((bytes) => {
            if (!slot.closed) this.onDataRange(begin, bytes);
          }, fail);
        }
      }
      const range = new CoreRange(first.size, first.bytes);
      // Scanned figures (fax, JBIG2, JPEG 2000) decode in modules pdf.js loads from `wasmUrl`. The window's CSP allows
      // no WebAssembly, so it loads their JavaScript builds, which the build copies to pdfjs/ (electron.vite.config.ts).
      const task = pdfjs.getDocument({
        range,
        rangeChunkSize: CHUNK,
        disableAutoFetch: true,
        disableStream: true,
        useSystemFonts: true,
        useWasm: false,
        wasmUrl: new URL("pdfjs/", window.location.href).href,
      });
      // A panel that moved on or closed while pdf.js loaded destroys the task here, or when it closes.
      if (!slot.hold(task)) return;
      const doc = await task.promise;
      if (slot.closed) return;
      setPdf(doc);
      report.current.onOutcome({ count: doc.numPages });
    })().catch(fail);
    const shown = pictures.current;
    return () => {
      slot.dispose();
      for (const picture of shown.values()) picture.close();
      shown.clear();
      kept.current = [];
    };
  }, [sourceId, passageId]);

  useEffect(() => {
    const target = canvas.current;
    const layerBox = text.current;
    if (!pdf || !target || !layerBox || width <= 0 || page < 1 || page > pdf.numPages) return;
    let disposed = false;
    let render: RenderTask | undefined;
    let layer: TextLayer | undefined;
    const slow = setTimeout(() => setWorking(true), SHOW_WORK_AFTER);
    setMark(null);
    void (async () => {
      const [pdfjs, current] = await Promise.all([loadPdfjs(), pdf.getPage(page)]);
      if (disposed) return;
      const natural = current.getViewport({ scale: 1 });
      const viewport = current.getViewport({ scale: width / natural.width });
      const dpr = window.devicePixelRatio || 1;
      const key = `${page}@${Math.round(width * dpr)}`;
      const picture = pictures.current.get(key);
      // Drawn off screen first, so the page on screen changes in one step and never shows half a page.
      const scratch = document.createElement("canvas");
      scratch.width = Math.ceil(viewport.width * dpr);
      scratch.height = Math.ceil(viewport.height * dpr);
      if (!picture) {
        render = current.render({ canvas: scratch, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
        await render.promise;
        if (disposed) return;
        const bitmap = await createImageBitmap(scratch);
        // The panel may have moved on while the picture was made: an old picture must not come back after the clean-up
        // or take the place of a newer one.
        if (disposed) {
          bitmap.close();
          return;
        }
        // One picture a page: a resize passes through many widths, and only the last one is kept.
        keepPicture(pictures.current, page, key, bitmap);
      }
      const content = await current.getTextContent();
      if (disposed) return;
      target.width = scratch.width;
      target.height = scratch.height;
      target.style.width = `${viewport.width}px`;
      target.style.height = `${viewport.height}px`;
      target.getContext("2d")?.drawImage(pictures.current.get(key) ?? scratch, 0, 0);
      layerBox.replaceChildren();
      layerBox.style.setProperty("--total-scale-factor", String(viewport.scale));
      layer = new pdfjs.TextLayer({ textContentSource: content, container: layerBox, viewport });
      await layer.render();
      if (disposed) return;
      clearTimeout(slow);
      setWorking(false);
      setRatio(natural.height / natural.width);
      setDrawn(page);
      const runs = layer.textContentItemsStr;
      report.current.onScan(runs.every((run) => !run.trim()));
      // The cited passage, on its own page only: a mark in the margin beside its lines, and the lines named for a screen
      // reader. No colour goes behind the text.
      if (excerpt && page === citedPage) {
        const hits = citedRuns(runs, excerpt);
        const spans = hits.map((index) => layer!.textDivs[index]).filter((span): span is HTMLElement => Boolean(span));
        for (const span of spans) span.classList.add("is-cited");
        report.current.onMarked(spans.length > 0);
        if (spans.length) {
          const origin = layerBox.getBoundingClientRect();
          const rects = spans.map((span) => span.getBoundingClientRect());
          const top = Math.min(...rects.map((rect) => rect.top)) - origin.top;
          const bottom = Math.max(...rects.map((rect) => rect.bottom)) - origin.top;
          const left = Math.min(...rects.map((rect) => rect.left)) - origin.left;
          setMark({ top, height: Math.max(12, bottom - top), left });
          spans[0]!.scrollIntoView({ block: "center" });
        }
      } else if (excerpt) report.current.onMarked(false);
      // Pages no longer kept are let go: their picture and what pdf.js keeps for them.
      const next = keepPages(kept.current, page);
      kept.current = next.kept;
      for (const gone of next.dropped) {
        for (const [name, image] of pictures.current)
          if (name.startsWith(`${gone}@`)) {
            image.close();
            pictures.current.delete(name);
          }
        void pdf.getPage(gone).then((old) => old.cleanup());
      }
    })().catch((err: unknown) => {
      // A failed read already said why, and destroyed the document this page was drawn from.
      if (disposed || broken.current || (err instanceof Error && err.name === "RenderingCancelledException")) return;
      clearTimeout(slow);
      setWorking(false);
      report.current.onOutcome({ error: "failed", detail: err instanceof Error ? err.message : String(err) });
    });
    return () => {
      disposed = true;
      clearTimeout(slow);
      render?.cancel();
      layer?.cancel();
    };
  }, [pdf, page, width, excerpt, citedPage]);

  const pageName = t("sources.viewer.pageOf", { page, count: pdf?.numPages ?? page });
  // The page drawn before stays on screen while the next one is prepared; the working state shows over it only when that
  // takes a while, and in place of the page before the first one is drawn.
  const first = drawn === null;
  return (
    <div ref={box} className="source-pdf" data-bytes-read={read.current}>
      <div
        className={first ? "source-pdf-page is-preparing" : "source-pdf-page"}
        style={first ? { aspectRatio: `1 / ${ratio}` } : undefined}
        role="group"
        aria-label={pageName}
        aria-busy={drawn !== page}
      >
        <canvas ref={canvas} aria-hidden hidden={first} />
        <div ref={text} className="source-pdf-text" />
        {drawn === page && mark ? (
          <span
            className="source-cite-mark"
            style={{ top: mark.top, height: mark.height, left: Math.max(4, mark.left - 14) }}
            aria-hidden
          />
        ) : null}
        {working ? (
          <div className="source-page-working">
            <Logo working decorative size={44} />
            <span>{t("sources.viewer.preparing", { page })}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
