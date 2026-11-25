import { useQuery } from "@tanstack/react-query";
import { invoke } from "../lib/ipc";
import {
  anchoredChecks,
  fencedChecks,
  stripCheckFences,
  type AnchoredCheck,
  type MathCheck,
} from "@shared/math-check";
import { createContext, isValidElement, memo, useContext, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import { citedPassage, type CitationResolver } from "../markdown/citations";
import { rehypePlugins, remarkPlugins } from "../markdown/plugins";
import { markdownSource } from "../markdown/source";
import { CheckBadge } from "./CheckBadge";
import { CitationChip } from "./CitationChip";
import { PythonBlock, RunnablePython } from "./PythonBlock";
import { Figure } from "./Figure";
import { darkFigureKey, figureKey, parseFigure } from "@shared/smart-text";
import { TOOL_FENCE } from "@shared/tool-blocks";
import { CHART_FENCE, QUESTION_FENCE, chatQuestion } from "@shared/chat-blocks";
import { ChartBlock } from "./ChartBlock";
import { QuestionBlock } from "./QuestionBlock";
import "./MarkdownView.css";

export type { CitationResolver };

const urlTransform = (url: string) =>
  /^(?:cite:p|mathcheck:)\d+$/.test(url) || HELD_MATH.test(url) ? url : defaultUrlTransform(url);

/** The link `holdOpenMath` writes for a formula whose closing delimiter has not arrived: its kind and the characters so far. */
const HELD_MATH = /^pyxis-math:(inline|display):(\d+)$/;

/** What the shared renderers below need from the message they draw. */
type MarkdownScope = {
  claims: MathCheck[];
  canRun: boolean;
  onCitationClick?: (passageId: number) => void;
  citationResolver?: CitationResolver;
  figures?: Record<string, string>;
  drawing: boolean;
  toolBlock?: (line: string) => ReactNode;
  blocks?: ChatBlocks;
};

/**
 * A chat reply's own blocks (```pyxis-chart, ```pyxis-question): the student's stored answers by question id, and what
 * «Controlla» and «Un'altra domanda» do. Without it the view draws those fences as code, as anywhere else.
 */
export type ChatBlocks = {
  answers?: Record<string, number>;
  onCheck?: (questionId: string, pick: number) => Promise<number>;
  onAnother?: () => void;
  /** A question has an option picked and not checked yet (true), or no longer (false). */
  onPicking?: (questionId: string, picking: boolean) => void;
};
const Scope = createContext<MarkdownScope>({ claims: [], canRun: false, drawing: false });

const components: Components = {
  a: function Link({ href, children: linkChildren, node: _node, ...rest }) {
    const { claims, onCitationClick, citationResolver } = useContext(Scope);
    const held = href?.match(HELD_MATH);
    if (held) return <FormulaPending display={held[1] === "display"} size={Number(held[2])} />;
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
    const { canRun, figures, drawing, toolBlock, blocks } = useContext(Scope);
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
    // What a Pyxis tool did, which the page that shows the reply draws; elsewhere nothing.
    if (lang === TOOL_FENCE) return <>{toolBlock?.(codeText.trim()) ?? null}</>;
    // A chart or a practice question the reply wrote: drawn by the app, never shown as its JSON.
    if (blocks && lang === CHART_FENCE) return <ChartBlock body={codeText} drawing={drawing} />;
    if (blocks && lang === QUESTION_FENCE) {
      const question = chatQuestion(codeText);
      return (
        <QuestionBlock
          question={question}
          pick={question ? blocks.answers?.[question.id] : undefined}
          drawing={drawing}
          onCheck={blocks.onCheck}
          onAnother={blocks.onAnother}
          onPicking={blocks.onPicking}
        />
      );
    }
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
  citationResolver,
  onCitationClick,
  runnable,
  checks,
  figures,
  drawing = false,
  toolBlock,
  blocks,
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
  citationResolver?: CitationResolver;
  onCitationClick?: (passageId: number) => void;
  /** Python blocks get an editor and a Run button; defaults to on inside tutor messages. */
  runnable?: boolean;
  /** Draws a ```pyxis-tool block from its one line (a tool result's id, or `pending:<tool>`). Without it they show nothing. */
  toolBlock?: (line: string) => ReactNode;
  /** Draws the chat's chart and question blocks; see `ChatBlocks`. */
  blocks?: ChatBlocks;
}) {
  const inherited = useContext(RunnablePython);
  const canRun = runnable ?? inherited;
  const claims = useMemo(
    () => anchoredChecks(children, checks ?? fencedChecks(children)),
    [children, checks],
  );
  const source = useMemo(
    () =>
      markdownSource(
        stripCheckFences(children),
        citationResolver,
        drawing,
        claims.map((claim) => claim.step),
      ),
    [children, citationResolver, claims, drawing],
  );
  const scope = useMemo(
    () => ({ claims, canRun, onCitationClick, citationResolver, figures, drawing, toolBlock, blocks }),
    [claims, canRun, onCitationClick, citationResolver, figures, drawing, toolBlock, blocks],
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
    />
  ) : (
    <span className="meta" role="status">
      {t("components.markdown.checking")}
    </span>
  );
}
