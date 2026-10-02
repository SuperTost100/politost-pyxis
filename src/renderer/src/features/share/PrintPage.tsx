import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeMathDelimiters } from "../../markdown/normalizeMathDelimiters";
import "katex/dist/katex.min.css";
import "katex/contrib/mhchem";
import "./PrintPage.css";

export function PrintPage() {
  const [markdown, setMarkdown] = useState<string | null>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = "light";
    document.body.classList.add("px-print-body");
    let cancelled = false;
    void window.pyxis.printData().then((data) => {
      if (!cancelled && data)
        setMarkdown(normalizeMathDelimiters(data.markdown));
    });
    return () => {
      cancelled = true;
      document.body.classList.remove("px-print-body");
    };
  }, []);
  useEffect(() => {
    if (markdown === null) return;
    let cancelled = false;
    void document.fonts.ready.then(() =>
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
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{ img: ({ alt }) => <span>{alt ?? ""}</span> }}
      >
        {markdown ?? ""}
      </ReactMarkdown>
    </main>
  );
}
