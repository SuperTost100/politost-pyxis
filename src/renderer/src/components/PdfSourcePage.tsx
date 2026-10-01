import { Button } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist";
import { Notice } from "./Notice";

export default function PdfSourcePage({ sha, initialPage, excerpt }: { sha: string; initialPage: number; excerpt: string }) {
  const { t } = useTranslation();
  const [pageNumber, setPageNumber] = useState(initialPage);
  const [count, setCount] = useState(0);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let disposed = false;
    let pdf: PDFDocumentProxy | undefined;
    const controller = new AbortController();
    setDocument(null); setPageNumber(initialPage); setError(null);
    void (async () => {
      const [pdfjs, response] = await Promise.all([
        import("pdfjs-dist/legacy/build/pdf.mjs"), fetch(`pyxis-blob://${sha}`, { signal: controller.signal }),
      ]);
      if (!response.ok) throw new Error("pdf-missing");
      const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const data = new Uint8Array(await response.arrayBuffer());
      if (disposed) return;
      pdf = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
      if (disposed) { await pdf.destroy(); return; }
      setCount(pdf.numPages); setPageNumber(Math.max(1, Math.min(initialPage, pdf.numPages))); setDocument(pdf);
    })().catch((err: unknown) => { if (!disposed) setError(err instanceof Error ? err.message : "pdf-render-failed"); });
    return () => { disposed = true; controller.abort(); void pdf?.destroy(); };
  }, [sha, initialPage]);
  useEffect(() => {
    if (!document || !canvas.current || !text.current) return;
    let disposed = false;
    let render: RenderTask | undefined;
    let layer: TextLayer | undefined;
    const target = canvas.current;
    const textTarget = text.current;
    textTarget.replaceChildren();
    void (async () => {
      const [page, pdfjs] = await Promise.all([document.getPage(pageNumber), import("pdfjs-dist/legacy/build/pdf.mjs")]);
      if (disposed) return;
      const viewport = page.getViewport({ scale: Math.max(1, width) / page.getViewport({ scale: 1 }).width });
      target.width = Math.ceil(viewport.width); target.height = Math.ceil(viewport.height);
      textTarget.style.setProperty("--scale-factor", String(viewport.scale));
      textTarget.style.width = `${viewport.width}px`; textTarget.style.height = `${viewport.height}px`;
      const context = target.getContext("2d");
      if (!context) throw new Error("canvas-missing");
      render = page.render({ canvasContext: context, viewport });
      const content = await page.getTextContent();
      if (disposed) return;
      layer = new pdfjs.TextLayer({ textContentSource: content, container: textTarget, viewport });
      await Promise.all([render.promise, layer.render()]);
      if (disposed || pageNumber !== initialPage) return;
      const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
      const strings = layer.textContentItemsStr;
      const full = strings.map(normalize).filter(Boolean).join(" ");
      const needle = normalize(excerpt);
      const start = full.indexOf(needle);
      if (start >= 0) {
        let offset = 0;
        strings.forEach((value, i) => {
          const length = normalize(value).length;
          if (length === 0) return;
          if (offset < start + needle.length && offset + length > start) layer!.textDivs[i]?.classList.add("is-cited");
          offset += length + 1;
        });
        textTarget.querySelector(".is-cited")?.scrollIntoView({ block: "center" });
      }
    })().catch((err: unknown) => { if (!disposed) setError(err instanceof Error ? err.message : "pdf-render-failed"); });
    return () => { disposed = true; render?.cancel(); layer?.cancel(); };
  }, [document, pageNumber, width, excerpt, initialPage]);
  return <div ref={container}>
    <div className="source-pdf-navigation">
      <Button disabled={pageNumber <= 1} onClick={() => setPageNumber((n) => n - 1)}>{t("sources.previousPage")}</Button>
      <span className="meta">{t("sources.pageNumber", { page: pageNumber, count })}</span>
      <Button disabled={pageNumber >= count} onClick={() => setPageNumber((n) => n + 1)}>{t("sources.nextPage")}</Button>
    </div>
    {error ? <Notice tone="danger" details={error}>{t("sources.pdfFailed")}</Notice> : null}
    <div className="source-pdf-page"><canvas ref={canvas} aria-label={t("sources.pageNumber", { page: pageNumber, count })} /><div ref={text} className="source-pdf-text" /></div>
  </div>;
}
