import { Button } from "antd";
import { Lightbulb } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  figureKey,
  parseSmartText,
  type CheckQuestion,
  type SmartBlock,
  type SmartSegment,
} from "@shared/smart-text";
import { arrowTarget, letterIndex, letterKeysHere, letterQuestion } from "./finalKeys";
import { Figure } from "./Figure";
import { InlineMarkdown } from "./InlineMarkdown";
import { MarkdownView, type CitationResolver } from "./MarkdownView";
import { QuizOption } from "./QuizOption";
import "./SmartText.css";
import { Working } from "./Working";

/** Saves a pick. A rejection with `dropped: true` means the pick was discarded on purpose: the check reverts without an error. */
export type SmartAnswer = (questionId: string, pick: number) => Promise<unknown>;

type Answers = {
  picks: Record<string, number>;
  /** Questions can be answered: `onAnswer` is set. A question in text still being written can be, once its block has closed. */
  live: boolean;
  failed: string | null;
  pick: (questionId: string, pick: number) => void;
  /** The final question's label in place of the quick check's, and whether its keys answer it. */
  final: { id: string | null; label?: string; keys: boolean };
};

/**
 * The block that finishes a lesson part, the last check or the closing recap, whichever comes last, and the ids of the
 * questions it asks.
 */
function finalQuestions(segments: SmartSegment[]): { blockId: string; questions: string[] } | null {
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index]!;
    if (segment.type !== "block") continue;
    if (segment.block.kind === "check") return { blockId: segment.block.id, questions: [segment.block.id] };
    if (segment.block.kind === "recap")
      return { blockId: segment.block.id, questions: segment.block.questions.map((question) => question.id) };
  }
  return null;
}

/**
 * Smart text: lesson prose with its interactive blocks. Answers are saved through `onAnswer`; the first pick of a
 * question stays. While `streaming`, an unfinished block shows a placeholder and cannot be answered; a closed block
 * can, and `onAnswer` decides when the pick is saved.
 */
export function SmartText({
  children,
  answers = {},
  onAnswer,
  streaming = false,
  onCitationClick,
  citationResolver,
  figures = {},
  final,
}: {
  children: string;
  answers?: Record<string, number>;
  onAnswer?: SmartAnswer;
  streaming?: boolean;
  onCitationClick?: (passageId: number) => void;
  /** The chip label of each [Pn]; without it the chips read "Pn". */
  citationResolver?: CitationResolver;
  /** Images of the figure blocks, by `figureKey`. While `streaming`, a figure without one is still being drawn. */
  figures?: Record<string, string>;
  /**
   * A lesson part's final question: the last check is labelled `label`, and with `keys` the letters A to D answer the
   * first question of that check or of the closing recap still open, and the arrows move between its options, while the
   * focus is on the page, in the question or on the sheet's title (`letterKeysHere`). Old lessons pass nothing.
   */
  final?: { label: string; keys: boolean };
}) {
  const { t } = useTranslation();
  const segments = useMemo(
    () => parseSmartText(children, { streaming }),
    [children, streaming],
  );
  const [local, setLocal] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const finalOn = Boolean(final);
  const closing = useMemo(() => (finalOn ? finalQuestions(segments) : null), [finalOn, segments]);
  const state: Answers = {
    picks: { ...local, ...answers },
    live: Boolean(onAnswer),
    failed,
    final: { id: closing?.blockId ?? null, label: final?.label, keys: Boolean(final?.keys) },
    pick(questionId, pick) {
      if (!onAnswer || questionId in answers || questionId in local) return;
      setFailed(null);
      setLocal((current) => ({ ...current, [questionId]: pick }));
      // A local pick only bridges the save: once saved, `answers` holds it. Kept longer, it would mark the same
      // question answered in the next lesson shown here, whose own answer would then never be saved.
      const settle = () => setLocal(({ [questionId]: _settled, ...rest }) => rest);
      onAnswer(questionId, pick).then(settle, (error: unknown) => {
        settle();
        if (!(error as { dropped?: unknown } | null)?.dropped) setFailed(questionId);
      });
    },
  };
  // The latest answers and pick, for the key listener that stays put between renders.
  const latest = useRef(state);
  latest.current = state;
  const keys = Boolean(final?.keys && closing && onAnswer);
  useEffect(() => {
    if (!keys || !closing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const now = latest.current;
      const active = document.activeElement;
      // The question whose options have the focus, when it is one of the final block's; otherwise the first one open.
      const holder = active?.closest<HTMLElement>("[data-question]");
      const focused = holder?.closest(`[data-final="${closing.blockId}"]`) ? (holder.dataset.question ?? null) : null;
      const open = letterQuestion(closing.questions, (id) => now.picks[id] !== undefined, focused);
      if (!open) return;
      const question = segments.flatMap((segment) =>
        segment.type !== "block"
          ? []
          : segment.block.kind === "check"
            ? [segment.block]
            : segment.block.kind === "recap"
              ? segment.block.questions
              : [],
      ).find((item) => item.id === open);
      const index = question ? letterIndex(event.key, question.options.length) : null;
      if (index === null) return;
      const inQuestion = Boolean(active?.closest(`[data-final="${closing.blockId}"]`));
      // The selection menu takes the keys while it shows, even with the focus on the page.
      if (!letterKeysHere(active, inQuestion) || document.querySelector(".px-selection-menu")) return;
      event.preventDefault();
      now.pick(open, index);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [keys, closing, segments]);
  return (
    <div className="px-smart">
      {segments.map((segment, index) =>
        segment.type === "markdown" ? (
          <MarkdownView
            key={index}
            runnable
            onCitationClick={onCitationClick}
            citationResolver={citationResolver}
          >
            {segment.text}
          </MarkdownView>
        ) : segment.type === "pending" && segment.kind === "figure" ? (
          <Figure key={index} caption="" drawing />
        ) : segment.type === "pending" ? (
          <div key={index} className="px-sb is-pending">
            <Working line={t("smart.preparing")} />
          </div>
        ) : segment.block.kind === "figure" ? (
          <Figure
            key={segment.block.id}
            caption={segment.block.caption}
            image={figures[figureKey(segment.block.code)]}
            drawing={streaming}
          />
        ) : (
          <Block key={segment.block.id} block={segment.block} answers={state} />
        ),
      )}
    </div>
  );
}

function Block({ block, answers }: { block: SmartBlock; answers: Answers }) {
  const { t } = useTranslation();
  switch (block.kind) {
    case "check": {
      const final = answers.final.id === block.id;
      const label = final && answers.final.label ? answers.final.label : t("smart.check");
      return (
        <section className="px-sb is-check" aria-label={label} data-final={final ? block.id : undefined}>
          <p className="label px-sb-label">{label}</p>
          <Question question={block} answers={answers} keys={final && answers.final.keys} />
        </section>
      );
    }
    case "recap":
      return <Recap block={block} answers={answers} />;
    case "try":
      return <TryIt block={block} />;
    case "reveal":
      return <Reveal block={block} />;
    // Drawn by SmartText itself, with the lesson's images.
    case "figure":
      return null;
    case "example":
      return (
        <section className="px-sb is-example" aria-label={t("smart.example")}>
          <p className="label px-sb-label">{t("smart.example")}</p>
          {block.title ? (
            <p className="body-strong px-sb-title">
              <InlineMarkdown>{block.title}</InlineMarkdown>
            </p>
          ) : null}
          <MarkdownView variant="body">{block.body}</MarkdownView>
        </section>
      );
  }
}

function Question({
  question,
  answers,
  counter,
  keys = false,
}: {
  question: CheckQuestion;
  answers: Answers;
  counter?: string;
  /** The final question of a lesson part: its letters answer it and the arrows move between its options. */
  keys?: boolean;
}) {
  const { t } = useTranslation();
  const picked = answers.picks[question.id];
  const answered = picked !== undefined;
  const right = picked === question.answer;
  return (
    <div className="px-sb-question" data-question={question.id}>
      {counter ? <p className="meta ink-muted">{counter}</p> : null}
      <MarkdownView variant="body">{question.question}</MarkdownView>
      <fieldset
        className="px-sb-options"
        disabled={!answers.live && !answered}
        onKeyDown={
          keys && !answered
            ? (event) => {
                const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".px-opt")];
                const target = arrowTarget(event.key, options.indexOf(event.target as HTMLButtonElement), options.length);
                if (target === null || !options.includes(event.target as HTMLButtonElement)) return;
                event.preventDefault();
                options[target]!.focus();
              }
            : undefined
        }
      >
        <legend className="visually-hidden">{t("smart.options")}</legend>
        {question.options.map((option, index) => (
          <QuizOption
            key={index}
            letter={String.fromCharCode(65 + index)}
            letterKey={keys}
            math={option}
            state={
              !answered
                ? "idle"
                : index === question.answer
                  ? "correct"
                  : index === picked
                    ? "wrong"
                    : "idle"
            }
            onClick={
              answered ? undefined : () => answers.pick(question.id, index)
            }
          >
            <InlineMarkdown>{option}</InlineMarkdown>
          </QuizOption>
        ))}
      </fieldset>
      <div aria-live="polite">
        {answered ? (
          <div className={`px-sb-feedback ${right ? "is-right" : "is-wrong"}`}>
            <p className="body-strong">
              {right ? t("smart.right") : t("smart.notQuite")}
            </p>
            {question.explanation ? (
              <MarkdownView variant="body">{question.explanation}</MarkdownView>
            ) : null}
          </div>
        ) : answers.failed === question.id ? (
          <p className="small px-sb-error" role="alert">
            {t("smart.answerFailed")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Recap({
  block,
  answers,
}: {
  block: Extract<SmartBlock, { kind: "recap" }>;
  answers: Answers;
}) {
  const { t } = useTranslation();
  const count = block.questions.length;
  const done = block.questions.filter((q) => answers.picks[q.id] !== undefined);
  const right = done.filter((q) => answers.picks[q.id] === q.answer).length;
  return (
    <section
      className="px-sb is-recap"
      aria-label={t("smart.recap")}
      data-final={answers.final.id === block.id ? block.id : undefined}
    >
      <div className="px-sb-head">
        <p className="label px-sb-label">{t("smart.recap")}</p>
        <p className="meta ink-muted">
          {done.length === count
            ? t("smart.recapScore", { right, count })
            : t("smart.recapProgress", { done: done.length, count })}
        </p>
      </div>
      {block.questions.map((question, index) => (
        <Question
          key={question.id}
          question={question}
          answers={answers}
          counter={t("smart.question", { n: index + 1, count })}
          keys={answers.final.id === block.id && answers.final.keys}
        />
      ))}
    </section>
  );
}

function TryIt({ block }: { block: Extract<SmartBlock, { kind: "try" }> }) {
  const { t } = useTranslation();
  const [hint, setHint] = useState(false);
  const [shown, setShown] = useState(0);
  const total = block.steps.length;
  const finished = shown >= total;
  return (
    <section className="px-sb is-try" aria-label={t("smart.try")}>
      <p className="label px-sb-label">{t("smart.try")}</p>
      <MarkdownView variant="body">{block.prompt}</MarkdownView>
      {hint && block.hint ? (
        <div className="px-sb-hint">
          <Lightbulb size={16} strokeWidth={1.75} aria-hidden />
          <div>
            <p className="label">{t("smart.hintLabel")}</p>
            <MarkdownView variant="body">{block.hint}</MarkdownView>
          </div>
        </div>
      ) : null}
      {shown > 0 ? (
        <ol className="px-sb-steps" aria-live="polite">
          {block.steps.slice(0, shown).map((step, index) => (
            <li key={index}>
              <span className="meta ink-muted">
                {t("smart.step", { n: index + 1 })}
              </span>
              <MarkdownView variant="body">{step}</MarkdownView>
            </li>
          ))}
        </ol>
      ) : (
        <p className="small ink-muted">{t("smart.tryFirst")}</p>
      )}
      {finished && block.answer ? (
        <div className="px-sb-result">
          <span className="label">{t("smart.answer")}</span>
          <InlineMarkdown>{block.answer}</InlineMarkdown>
        </div>
      ) : null}
      {!finished ? (
        <div className="px-sb-actions">
          {block.hint && !hint && shown === 0 ? (
            <Button size="small" shape="round" onClick={() => setHint(true)}>
              {t("smart.hint")}
            </Button>
          ) : null}
          <Button
            size="small"
            shape="round"
            onClick={() => setShown((value) => value + 1)}
          >
            {shown === 0
              ? t("smart.firstStep")
              : t("smart.nextStep", { n: shown + 1, count: total })}
          </Button>
          {total - shown > 1 ? (
            <Button size="small" shape="round" type="text" onClick={() => setShown(total)}>
              {t("smart.allSteps")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Reveal({ block }: { block: Extract<SmartBlock, { kind: "reveal" }> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = block.style === "why" ? t("smart.why") : t("smart.term");
  return (
    <section className={`px-sb is-reveal${open ? " is-open" : ""}`} aria-label={label}>
      <button
        type="button"
        className="px-sb-reveal"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="label px-sb-label">{label}</span>
        <span className="px-sb-front">
          <InlineMarkdown>{block.front}</InlineMarkdown>
        </span>
        <span className="px-sb-toggle small">
          {open ? t("smart.hide") : t("smart.show")}
          <span className="px-chevron" aria-hidden />
        </span>
      </button>
      {open ? (
        <div className="px-sb-back">
          <MarkdownView variant="body">{block.back}</MarkdownView>
        </div>
      ) : null}
    </section>
  );
}
