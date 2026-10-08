import { Button } from "antd";
import { ChevronDown, Lightbulb } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  parseSmartText,
  type CheckQuestion,
  type SmartBlock,
} from "@shared/smart-text";
import { InlineMarkdown } from "./InlineMarkdown";
import { MarkdownView } from "./MarkdownView";
import { QuizOption } from "./QuizOption";
import "./SmartText.css";

export type SmartAnswer = (questionId: string, pick: number) => Promise<unknown>;

type Answers = {
  picks: Record<string, number>;
  /** Saving the answer is possible: false while the text is still being written. */
  live: boolean;
  failed: string | null;
  pick: (questionId: string, pick: number) => void;
};

/**
 * Smart text: lesson prose with its interactive blocks. Answers are saved through `onAnswer`; the first pick of a
 * question stays. While `streaming`, an unfinished block shows a placeholder and nothing can be answered yet.
 */
export function SmartText({
  children,
  answers = {},
  onAnswer,
  streaming = false,
  onCitationClick,
}: {
  children: string;
  answers?: Record<string, number>;
  onAnswer?: SmartAnswer;
  streaming?: boolean;
  onCitationClick?: (passageId: number) => void;
}) {
  const { t } = useTranslation();
  const segments = useMemo(
    () => parseSmartText(children, { streaming }),
    [children, streaming],
  );
  const [local, setLocal] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const state: Answers = {
    picks: { ...local, ...answers },
    live: !streaming && Boolean(onAnswer),
    failed,
    pick(questionId, pick) {
      if (!onAnswer || questionId in answers || questionId in local) return;
      setFailed(null);
      setLocal((current) => ({ ...current, [questionId]: pick }));
      onAnswer(questionId, pick).catch(() => {
        setLocal(({ [questionId]: _dropped, ...rest }) => rest);
        setFailed(questionId);
      });
    },
  };
  return (
    <div className="px-smart">
      {segments.map((segment, index) =>
        segment.type === "markdown" ? (
          <MarkdownView
            key={index}
            runnable
            onCitationClick={onCitationClick}
          >
            {segment.text}
          </MarkdownView>
        ) : segment.type === "pending" ? (
          <div key={index} className="px-sb is-pending" role="status">
            <span className="label">{t("smart.preparing")}</span>
            <span className="px-sb-skeleton" />
            <span className="px-sb-skeleton is-short" />
          </div>
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
    case "check":
      return (
        <section className="px-sb is-check" aria-label={t("smart.check")}>
          <p className="label px-sb-label">{t("smart.check")}</p>
          <Question question={block} answers={answers} />
        </section>
      );
    case "recap":
      return <Recap block={block} answers={answers} />;
    case "try":
      return <TryIt block={block} />;
    case "reveal":
      return <Reveal block={block} />;
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
}: {
  question: CheckQuestion;
  answers: Answers;
  counter?: string;
}) {
  const { t } = useTranslation();
  const picked = answers.picks[question.id];
  const answered = picked !== undefined;
  const right = picked === question.answer;
  return (
    <div className="px-sb-question">
      {counter ? <p className="meta ink-muted">{counter}</p> : null}
      <MarkdownView variant="body">{question.question}</MarkdownView>
      <fieldset className="px-sb-options" disabled={!answers.live && !answered}>
        <legend className="visually-hidden">{t("smart.options")}</legend>
        {question.options.map((option, index) => (
          <QuizOption
            key={index}
            letter={String.fromCharCode(65 + index)}
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
    <section className="px-sb is-recap" aria-label={t("smart.recap")}>
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
          <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
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
