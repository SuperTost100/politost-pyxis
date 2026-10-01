import { Button } from "antd";
import type { ComponentPropsWithoutRef } from "react";
import { isValidElement, useMemo } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import "katex/contrib/mhchem";
import {
  mapOutsideCode,
  normalizeMathDelimiters,
} from "../markdown/normalizeMathDelimiters";
import { CheckBadge } from "./CheckBadge";
import { CitationChip } from "./CitationChip";
import { checkClaim } from "../../../core/math/check";
import "./MarkdownView.css";

export type CitationResolver = (passageId: number) => string | undefined;

function linkCitations(markdown: string, resolver?: CitationResolver): string {
  return mapOutsideCode(markdown, (text) =>
    text.replace(/\[P(\d+)\]/g, (_, raw: string) => {
      const id = Number(raw);
      const label = resolver?.(id) ?? `P${id}`;
      return `[${label}](cite:p${id})`;
    }),
  );
}

export function MarkdownView({
  children,
  variant = "reading",
  citationResolver,
  onCitationClick,
  onRunPython,
}: {
  children: string;
  variant?: "reading" | "body";
  citationResolver?: CitationResolver;
  onCitationClick?: (passageId: number) => void;
  onRunPython?: (code: string) => void;
}) {
  const { t } = useTranslation();
  const source = useMemo(() => {
    const withCites = linkCitations(children, citationResolver);
    return normalizeMathDelimiters(withCites);
  }, [children, citationResolver]);

  return (
    <div className={["px-markdown", `is-${variant}`].join(" ")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        skipHtml
        urlTransform={(url) =>
          /^cite:p\d+$/.test(url) ? url : defaultUrlTransform(url)
        }
        components={{
          a: ({ href, children: linkChildren, ...rest }) => {
            const match = href?.match(/^cite:p(\d+)$/);
            if (match) {
              const id = Number(match[1]);
              return (
                <CitationChip onClick={() => onCitationClick?.(id)}>
                  {linkChildren}
                </CitationChip>
              );
            }
            return (
              <a href={href} {...rest} rel="noreferrer" target="_blank">
                {linkChildren}
              </a>
            );
          },
          pre: ({ children: preChildren, ...rest }) => {
            let codeText = "";
            let lang = "";
            const child = Array.isArray(preChildren)
              ? preChildren[0]
              : preChildren;
            if (isValidElement(child) && child.props) {
              const props = child.props as {
                className?: string;
                children?: unknown;
              };
              lang = props.className?.replace("language-", "") ?? "";
              codeText = String(props.children ?? "").replace(/\n$/, "");
            }
            const isPython = lang === "python";
            const claim =
              lang === "check"
                ? (() => {
                    try {
                      const body = JSON.parse(codeText) as {
                        kind?: string;
                        expr?: string;
                        claimed?: string;
                      };
                      if (!body.kind || !body.expr || !body.claimed) return null;
                      return checkClaim({ kind: body.kind, expr: body.expr, claimed: body.claimed });
                    } catch {
                      return null;
                    }
                  })()
                : null;
            return (
              <div className="px-code-block">
                <pre className="px-code-pre" {...rest}>{preChildren}</pre>
                {claim ? (
                  <CheckBadge
                    state={claim}
                    verifiedLabel={t("components.markdown.verified")}
                    failedLabel={t("components.markdown.failed")}
                  />
                ) : null}
                {isPython && onRunPython ? (
                  <Button
                    type="default"
                    shape="round"
                    size="small"
                    className="px-code-run"
                    onClick={() => onRunPython(codeText)}
                  >
                    {t("components.markdown.run")}
                  </Button>
                ) : null}
              </div>
            );
          },
          code: ({ className, children, ...rest }: ComponentPropsWithoutRef<"code"> & { inline?: boolean }) => {
            if (!className) {
              return (
                <code className={className} {...rest}>{children}</code>
              );
            }
            return (
              <code className={className} {...rest}>{children}</code>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
