import { useQuery } from "@tanstack/react-query";
import { invoke } from "../lib/ipc";
import {
  anchoredChecks,
  fencedChecks,
  stripCheckFences,
  type AnchoredCheck,
  type MathCheck,
} from "@shared/math-check";
import type { ComponentPropsWithoutRef } from "react";
import { isValidElement, useContext, useMemo } from "react";
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
import { PythonBlock, RunnablePython } from "./PythonBlock";
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
  runnable,
  checks,
}: {
  children: string;
  checks?: AnchoredCheck[];
  variant?: "reading" | "body";
  citationResolver?: CitationResolver;
  onCitationClick?: (passageId: number) => void;
  /** Python blocks get an editor and a Run button; defaults to on inside tutor messages. */
  runnable?: boolean;
}) {
  const inherited = useContext(RunnablePython);
  const canRun = runnable ?? inherited;
  const claims = useMemo(
    () => anchoredChecks(children, checks ?? fencedChecks(children)),
    [children, checks],
  );
  const source = useMemo(() => {
    let body = stripCheckFences(children);
    const inserts = new Map<number, string[]>();
    claims.forEach((claim, index) => {
      const start = body.indexOf(claim.step);
      if (start < 0) return;
      const next = body.indexOf("\n\n", start + claim.step.length);
      const at = next < 0 ? body.length : next;
      inserts.set(at, [
        ...(inserts.get(at) ?? []),
        `[check](mathcheck:${index})`,
      ]);
    });
    for (const [at, markers] of [...inserts].sort((a, b) => b[0] - a[0])) {
      body = `${body.slice(0, at)}\n\n${markers.join(" ")}\n\n${body.slice(at)}`;
    }
    return normalizeMathDelimiters(linkCitations(body, citationResolver));
  }, [children, citationResolver, claims]);

  return (
    <div className={["px-markdown", `is-${variant}`].join(" ")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        skipHtml
        urlTransform={(url) =>
          /^(?:cite:p|mathcheck:)\d+$/.test(url)
            ? url
            : defaultUrlTransform(url)
        }
        components={{
          a: ({ href, children: linkChildren, ...rest }) => {
            const check = href?.match(/^mathcheck:(\d+)$/);
            if (check) {
              const claim = claims[Number(check[1])];
              return claim ? <AsyncCheck claim={claim} /> : null;
            }
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
            if (lang === "python" && canRun)
              return <PythonBlock code={codeText} />;
            return (
              <div className="px-code-block">
                <pre className="px-code-pre" tabIndex={0} {...rest}>
                  {preChildren}
                </pre>
              </div>
            );
          },
          code: ({
            className,
            children,
            ...rest
          }: ComponentPropsWithoutRef<"code"> & { inline?: boolean }) => {
            if (!className) {
              return (
                <code className={className} {...rest}>
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

function AsyncCheck({ claim }: { claim: MathCheck }) {
  const { t } = useTranslation();
  const { kind, expr, claimed, vars } = claim;
  const input = { kind, expr, claimed, vars };
  const result = useQuery({
    queryKey: ["math-check", input],
    queryFn: () => invoke("tools.check", input),
    retry: false,
    staleTime: 60000,
  });
  return result.data || result.isError ? (
    <CheckBadge
      state={result.data?.state ?? "none"}
      reason={result.data?.reason}
      verifiedLabel={t("components.markdown.verified")}
      failedLabel={t("components.markdown.failed")}
      uncheckableLabel={t("components.markdown.uncheckable")}
    />
  ) : (
    <span className="meta" role="status">
      {t("components.markdown.checking")}
    </span>
  );
}
