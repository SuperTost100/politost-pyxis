import { useQuery } from "@tanstack/react-query";
import { invoke } from "../lib/ipc";
import {
  anchoredChecks,
  fencedChecks,
  stripCheckFences,
  type AnchoredCheck,
  type MathCheck,
} from "@shared/math-check";
import { createContext, isValidElement, memo, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import { citedPassage, linkCitations, type CitationResolver } from "../markdown/citations";
import { displayMathLines, normalizeMathDelimiters } from "../markdown/normalizeMathDelimiters";
import { rehypePlugins, remarkPlugins } from "../markdown/plugins";
import { CheckBadge } from "./CheckBadge";
import { CitationChip } from "./CitationChip";
import { PythonBlock, RunnablePython } from "./PythonBlock";
import { Figure } from "./Figure";
import { figureKey, parseFigure } from "@shared/smart-text";
import "./MarkdownView.css";

export type { CitationResolver };

const urlTransform = (url: string) =>
  /^(?:cite:p|mathcheck:)\d+$/.test(url) ? url : defaultUrlTransform(url);

/** What the shared renderers below need from the message they draw. */
type MarkdownScope = {
  claims: MathCheck[];
  canRun: boolean;
  onCitationClick?: (passageId: number) => void;
  citationResolver?: CitationResolver;
  figures?: Record<string, string>;
  drawing: boolean;
};
const Scope = createContext<MarkdownScope>({ claims: [], canRun: false, drawing: false });

const components: Components = {
  a: function Link({ href, children: linkChildren, node: _node, ...rest }) {
    const { claims, onCitationClick, citationResolver } = useContext(Scope);
    const check = href?.match(/^mathcheck:(\d+)$/);
    if (check) {
      const claim = claims[Number(check[1])];
      return claim ? <AsyncCheck claim={claim} /> : null;
    }
    const id = citedPassage(href, citationResolver);
    if (id !== null) {
      return (
        <CitationChip onClick={() => onCitationClick?.(id)}>
          {linkChildren}
        </CitationChip>
      );
    }
    // A cite: link the reply wrote for a passage it was never given: its text, not a chip and not a link.
    if (href?.startsWith("cite:")) return <>{linkChildren}</>;
    return (
      <a href={href} {...rest} rel="noreferrer" target="_blank">
        {linkChildren}
      </a>
    );
  },
  // A wide table scrolls in its own box instead of pushing the page sideways.
  table: ({ children: tableChildren, node: _node, ...rest }) => (
    <div className="px-table-scroll" tabIndex={0}>
      <table {...rest}>{tableChildren}</table>
    </div>
  ),
  pre: function Pre({ children: preChildren, node: _node, ...rest }) {
    const { canRun, figures, drawing } = useContext(Scope);
    let codeText = "";
    let lang = "";
    const child = Array.isArray(preChildren) ? preChildren[0] : preChildren;
    if (isValidElement(child) && child.props) {
      const props = child.props as {
        className?: string;
        children?: unknown;
      };
      lang = props.className?.replace("language-", "") ?? "";
      codeText = String(props.children ?? "").replace(/\n$/, "");
    }
    if (lang === "python" && canRun) return <PythonBlock code={codeText} />;
    // Figure code is for the sandbox, never shown: the image, a placeholder while it is drawn, or nothing.
    if (lang === "pyxis-figure") {
      const figure = parseFigure(codeText);
      return (
        <Figure
          caption={figure?.caption ?? ""}
          image={figure ? figures?.[figureKey(figure.code)] : undefined}
          drawing={drawing}
        />
      );
    }
    return (
      <div className="px-code-block">
        <pre className="px-code-pre" tabIndex={0} {...rest}>
          {preChildren}
        </pre>
      </div>
    );
  },
};

/** Memoized: a long chat re-renders around its messages, and parsing Markdown and math again is the costly part. */
export const MarkdownView = memo(function MarkdownView({
  children,
  variant = "reading",
  citationResolver,
  onCitationClick,
  runnable,
  checks,
  figures,
  drawing = false,
}: {
  children: string;
  checks?: AnchoredCheck[];
  /** Images of the answer's ```pyxis-figure blocks, by `figureKey`. A block without one shows nothing. */
  figures?: Record<string, string>;
  /** The answer is still being written, so a figure without an image is still to be drawn. */
  drawing?: boolean;
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
    return displayMathLines(normalizeMathDelimiters(linkCitations(body, citationResolver)));
  }, [children, citationResolver, claims]);
  const scope = useMemo(
    () => ({ claims, canRun, onCitationClick, citationResolver, figures, drawing }),
    [claims, canRun, onCitationClick, citationResolver, figures, drawing],
  );
  // The same element for the same text, so React skips the parse; the renderers read a changed scope from context.
  const tree = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        skipHtml
        urlTransform={urlTransform}
        components={components}
      >
        {source}
      </ReactMarkdown>
    ),
    [source],
  );

  return (
    <div className={["px-markdown", `is-${variant}`].join(" ")}>
      <Scope.Provider value={scope}>{tree}</Scope.Provider>
    </div>
  );
});

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
