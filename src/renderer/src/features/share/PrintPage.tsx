import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { normalizeMathDelimiters } from "../../markdown/normalizeMathDelimiters";
import { rehypePlugins, remarkPlugins } from "../../markdown/plugins";
import "./PrintPage.css";

/** A concept map's drawing gets a page of its own size, so the PDF keeps it at full size. */
function MapFigure({ svg }: { svg: string }) {
  const size = /<svg[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/.exec(svg);
  const title = /<title>([^<]*)<\/title>/.exec(svg)?.[1] ?? "";
  const alt = new DOMParser().parseFromString(title, "text/html").body
    .textContent;
  return (
    <>
      {size ? (
        <style>{`@page map { size: ${size[1]}px ${size[2]}px; margin: 0; }`}</style>
      ) : null}
      <figure className="px-print-map">
        <img
          width={size ? Number(size[1]) : undefined}
          height={size ? Number(size[2]) : undefined}
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
          alt={alt ?? ""}
        />
      </figure>
    </>
  );
}

export function PrintPage() {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [svg, setSvg] = useState<string>();
  useEffect(() => {
    document.documentElement.dataset.theme = "light";
    document.body.classList.add("px-print-body");
    let cancelled = false;
    void window.pyxis.printData().then((data) => {
      if (!cancelled && data) {
        setSvg(data.svg);
        setMarkdown(normalizeMathDelimiters(data.markdown));
      }
    });
    return () => {
      cancelled = true;
      document.body.classList.remove("px-print-body");
    };
  }, []);
  useEffect(() => {
    if (markdown === null) return;
    let cancelled = false;
    // A map drawing is an image; it has to be decoded before the page prints.
    void Promise.all([
      document.fonts.ready,
      Promise.allSettled([...document.images].map((image) => image.decode())),
    ]).then(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!cancelled) void window.pyxis.printReady();
        }),
      ),
    );
    return () => {
      cancelled = true;
    };
  }, [markdown]);
  return (
    <main className="px-print-document">
      {svg ? <MapFigure svg={svg} /> : null}
      <ReactMarkdown
        skipHtml
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{ img: ({ alt }) => <span>{alt ?? ""}</span> }}
      >
        {markdown ?? ""}
      </ReactMarkdown>
    </main>
  );
}
