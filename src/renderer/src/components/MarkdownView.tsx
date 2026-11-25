import { useQueries, useQuery } from "@tanstack/react-query";
import { stripCheckFences, type AnchoredCheck, type MathCheck } from "@shared/math-check";
import { createContext, isValidElement, memo, useContext, useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import { checkQuery, textClaims } from "../lib/mathChecks";
import { citedPassage, type KnownPassage } from "../markdown/citations";
import { rehypeMarks } from "../markdown/marks";
import { rehypePlugins, remarkPlugins } from "../markdown/plugins";
import { markdownSource } from "../markdown/source";
import { CheckBadge } from "./CheckBadge";
import { PythonBlock, RunnablePython } from "./PythonBlock";
import { Figure } from "./Figure";
import { darkFigureKey, figureKey, parseFigure } from "@shared/smart-text";
import "./MarkdownView.css";

export type { KnownPassage };

/** After KaTeX: each check beside its step, and paragraphs of nothing but marks hidden. */
const viewRehypePlugins = [...rehypePlugins, rehypeMarks];

const urlTransform = (url: string) =>
  /^(?:cite:p|mathcheck:)\d+$/.test(url) || HELD_MATH.test(url) ? url : defaultUrlTransform(url);

/** The link `holdOpenMath` writes for a formula whose closing delimiter has not arrived: its kind and the characters so far. */
const HELD_MATH = /^pyxis-math:(inline|display):(\d+)$/;

/** What the shared renderers below need from the message they draw. */
type MarkdownScope = {
  claims: MathCheck[];
  canRun: boolean;
  knownPassage?: KnownPassage;
  figures?: Record<string, string>;
  drawing: boolean;
};
const Scope = createContext<MarkdownScope>({ claims: [], canRun: false, drawing: false });

const components: Components = {
  a: function Link({ href, children: linkChildren, node: _node, ...rest }) {
    const { claims, knownPassage } = useContext(Scope);
    const held = href?.match(HELD_MATH);
    if (held) return <FormulaPending display={held[1] === "display"} size={Number(held[2])} />;
    const check = href?.match(/^mathcheck:(\d+)$/);
    if (check) {
      const claim = claims[Number(check[1])];
      return claim ? <AsyncCheck claim={claim} /> : null;
    }
    // A citation mark: nothing to read or click in the text, only the place the sources row tints the words before.
    const id = citedPassage(href, knownPassage);
    if (id !== null) return <span className="px-cite-mark" data-cite={id} />;
    // A cite: link the reply wrote for a passage it was never given: its text, not a mark and not a link.
    if (href?.startsWith("cite:")) return <>{linkChildren}</>;
    return (
      <a href={href} {...rest} rel="noreferrer" target="_blank">
        {linkChildren}
      </a>
    );
  },
  // The checks of one step (`rehypeMarks`): its failures each say so, and its passes share one mark.
  div: function Div({ node, children: divChildren, ...rest }) {
    const classes = node?.properties?.["className"];
    if (Array.isArray(classes) && classes.includes("px-check-slot")) {
      const indexes = (node?.children ?? []).flatMap((child) => {
        const href = child.type === "element" ? String(child.properties?.["href"] ?? "") : "";
        const index = href.match(/^mathcheck:(\d+)$/)?.[1];
        return index === undefined ? [] : [Number(index)];
      });
      return <CheckSlot indexes={indexes} />;
    }
    return <div {...rest}>{divChildren}</div>;
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
      const key = figure ? figureKey(figure.code, figure.figureKind) : undefined;
      const image = key ? figures?.[key] : undefined;
      const darkImage = key ? figures?.[darkFigureKey(key)] : undefined;
      // While the reply is being drawn each figure shows its picture the moment it is there, and keeps its working state
      // until then. One left out is told as an empty picture, and its place goes.
      return <Figure caption={figure?.caption ?? ""} image={image} darkImage={darkImage} drawing={drawing && image === undefined} />;
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
  knownPassage,
  runnable,
  checks,
  figures,
  drawing = false,
}: {
  children: string;
  checks?: AnchoredCheck[];
  /** Images of the answer's ```pyxis-figure blocks, by `figureKey`. A block without one shows nothing. */
  figures?: Record<string, string>;
  /**
   * The answer is still being written: a figure without an image is still to be drawn, and a formula whose closing
   * delimiter has not arrived is a placeholder until it closes.
   */
  drawing?: boolean;
  variant?: "reading" | "body";
  /** Which [Pn] marks name a passage the page knows; a mark for any other is left out. Without it every mark counts. */
  knownPassage?: KnownPassage;
  /** Python blocks get an editor and a Run button; defaults to on inside tutor messages. */
  runnable?: boolean;
}) {
  const inherited = useContext(RunnablePython);
  const canRun = runnable ?? inherited;
  const claims = useMemo(() => textClaims(children, checks), [children, checks]);
  const source = useMemo(
    () =>
      markdownSource(
        stripCheckFences(children),
        knownPassage,
        drawing,
        claims.map((claim) => claim.step),
      ),
    [children, knownPassage, claims, drawing],
  );
  const scope = useMemo(
    () => ({ claims, canRun, knownPassage, figures, drawing }),
    [claims, canRun, knownPassage, figures, drawing],
  );
  // The same element for the same text, so React skips the parse; the renderers read a changed scope from context.
  const tree = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={viewRehypePlugins}
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

/** A formula still being written: a quiet bar of about its size, in the place the formula will be drawn. */
function FormulaPending({ display, size }: { display: boolean; size: number }) {
  return (
    <span
      className={display ? "px-formula-pending is-display" : "px-formula-pending"}
      style={display ? undefined : { width: `${Math.min(2 + size * 0.5, 14)}em` }}
      aria-hidden
    />
  );
}

/** A step's check, run when the step is drawn. While it runs nothing shows: the sources row says the checks are running. */
function AsyncCheck({ claim }: { claim: MathCheck }) {
  const result = useQuery(checkQuery(claim));
  return result.data || result.isError ? <CheckBadge state={result.data?.state ?? "none"} reason={result.data?.reason} /> : null;
}

/**
 * The checks of one step, run when the step is drawn: each failure under the step with its reason, and one mark beside it
 * for the ones that passed, however many, so the student sees one icon and the keyboard stops once. While they run
 * nothing shows: the sources row says the checks are running.
 */
function CheckSlot({ indexes }: { indexes: number[] }) {
  const { claims } = useContext(Scope);
  const own = indexes.map((index) => claims[index]).filter((claim): claim is MathCheck => claim !== undefined);
  const results = useQueries({ queries: own.map(checkQuery) });
  const passed = results.filter((result) => result.data?.state === "verified").length;
  return (
    <div className="px-check-slot">
      {results.map((result, index) =>
        result.data?.state === "failed" ? <CheckBadge key={index} state="failed" reason={result.data.reason} /> : null,
      )}
      {passed > 0 ? <CheckBadge state="verified" count={passed} /> : null}
    </div>
  );
}
