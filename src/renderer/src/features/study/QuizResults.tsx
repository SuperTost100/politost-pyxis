import { Button } from "antd";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon, type IconName } from "../../components/Icon";
import { InlineMarkdown } from "../../components/InlineMarkdown";
import { MarkdownView } from "../../components/MarkdownView";
import { openSourceViewer } from "../../components/SourceViewer";
import {
  stemText,
  verdict,
  type QuizAnswer,
  type QuizQuestion,
} from "./quizText";

const MARKS: Record<"correct" | "partial" | "wrong" | "flagged", IconName> = {
  correct: "circle-check",
  partial: "circle-alert",
  wrong: "circle-x",
  flagged: "flag",
};

function mark(row: QuizAnswer) {
  return row.flagged ? "flagged" : verdict(row.score);
}

/** Every answer of a finished quiz: the score, where to start (diagnostic), and each question to reopen. */
export function QuizResults({
  diagnostic,
  questions,
  results,
  score,
  topics,
  answerText,
  expectedText,
  onAsk,
  onWrong,
  wrongBusy,
  actions,
}: {
  diagnostic: boolean;
  questions: QuizQuestion[];
  results: QuizAnswer[];
  score: number;
  topics: Array<{ id: string; title: string }>;
  answerText: (id: string) => string;
  expectedText: (row: QuizAnswer) => string;
  onAsk: (row: QuizAnswer) => void;
  onWrong: (row: QuizAnswer, wrong: boolean) => void;
  wrongBusy?: string;
  actions: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const counted = results.filter((row) => !row.flagged);
  const points = counted.reduce((sum, row) => sum + row.score, 0);
  const number = new Intl.NumberFormat(i18n.language, {
    maximumFractionDigits: 1,
  });
  const percent = Math.round(score * 100);
  const toReview = counted.filter((row) => row.score < 1).length;
  const excluded = results.length - counted.length;
  const line = t(
    percent >= 90
      ? "quiz.verdictGreat"
      : percent >= 70
        ? "quiz.verdictGood"
        : percent >= 50
          ? "quiz.verdictClose"
          : "quiz.verdictStart",
  );
  const byTopic = diagnostic
    ? topics.flatMap((topic) => {
        const rows = counted.filter(
          (row) =>
            questions.find((question) => question.id === row.id)?.topicId ===
            topic.id,
        );
        if (!rows.length) return [];
        const value = rows.reduce((sum, row) => sum + row.score, 0);
        return [{ ...topic, value, total: rows.length }];
      })
    : [];
  return (
    <section className="px-quiz-results" aria-labelledby="quiz-score">
      <header className="px-quiz-hero">
        <p className="label px-quiz-eyebrow">
          {t(diagnostic ? "quiz.diagnosticDone" : "quiz.resultLabel")}
        </p>
        <p id="quiz-score" className="px-quiz-score" role="status">
          <span className="stat">{number.format(points)}</span>
          <span className="title-2 px-quiz-score-total">
            {t("quiz.outOf", { total: counted.length })}
          </span>
        </p>
        <p className="reading px-quiz-hero-line">
          <span className="px-quiz-percent">{percent}%</span>
          <span aria-hidden> · </span>
          {line}
        </p>
        <ol className="px-quiz-strip" aria-hidden>
          {results.map((row) => (
            <li key={row.id} className={`is-${mark(row)}`} />
          ))}
        </ol>
        <p className="small px-quiz-hero-meta">
          {[
            toReview ? t("quiz.toReview", { count: toReview }) : t("quiz.allCorrect"),
            excluded ? t("quiz.excludedCount", { count: excluded }) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </header>

      {byTopic.length ? (
        <section className="px-quiz-block" aria-labelledby="quiz-topics">
          <h3 id="quiz-topics" className="label px-quiz-block-title">
            {t("quiz.startHere")}
          </h3>
          <ul className="px-quiz-topics">
            {byTopic.map((topic) => {
              const share = topic.value / topic.total;
              const level =
                share >= 0.8 ? "solid" : share >= 0.5 ? "review" : "start";
              return (
                <li key={topic.id} className={`is-${level}`}>
                  <span className="body-strong px-quiz-topic-title">
                    {topic.title}
                  </span>
                  <span className="px-quiz-topic-bar" aria-hidden>
                    <span style={{ width: `${Math.round(share * 100)}%` }} />
                  </span>
                  <span className="meta px-quiz-topic-score">
                    {t("quiz.topicScore", {
                      points: number.format(topic.value),
                      total: topic.total,
                    })}
                  </span>
                  <span className="small px-quiz-topic-level">
                    {t(`quiz.topicLevel.${level}`)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="px-quiz-block" aria-labelledby="quiz-answers">
        <h3 id="quiz-answers" className="label px-quiz-block-title">
          {t("quiz.questions")}
        </h3>
        <ol className="px-quiz-rows">
          {results.map((row, index) => (
            <ResultRow
              key={row.id}
              index={index}
              row={row}
              question={questions.find((question) => question.id === row.id)}
              answer={answerText(row.id)}
              expected={expectedText(row)}
              busy={wrongBusy === row.id}
              onAsk={() => onAsk(row)}
              onWrong={(wrong) => onWrong(row, wrong)}
            />
          ))}
        </ol>
      </section>
      <div className="px-quiz-footer">{actions}</div>
    </section>
  );
}

function ResultRow({
  index,
  row,
  question,
  answer,
  expected,
  busy,
  onAsk,
  onWrong,
}: {
  index: number;
  row: QuizAnswer;
  question?: QuizQuestion;
  answer: string;
  expected: string;
  busy: boolean;
  onAsk: () => void;
  onWrong: (wrong: boolean) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const body = useId();
  const state = mark(row);
  const word = t(
    state === "flagged"
      ? "quiz.excluded"
      : state === "correct"
        ? "quiz.correct"
        : state === "partial"
          ? "quiz.partial"
          : "quiz.incorrect",
  );
  const kind = question?.grade.kind;
  const long = kind === "open";
  return (
    <li className={`px-quiz-row is-${state}${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="px-quiz-row-head"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="px-quiz-row-mark">
          <Icon name={MARKS[state]} size={18} strokeWidth={2} label={word} />
        </span>
        <span className="meta px-quiz-row-number" aria-hidden>
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="px-quiz-row-stem">
          <InlineMarkdown>{stemText(question?.stem ?? "")}</InlineMarkdown>
        </span>
        {state === "partial" ? (
          <span className="meta px-quiz-row-score">
            {Math.round(row.score * 100)}%
          </span>
        ) : null}
        <Icon name="chevron-right" size={16} className="px-quiz-chevron" />
      </button>
      {open ? (
        <div id={body} className="px-quiz-row-body">
          {question && /\n|\$\$/.test(question.stem) ? (
            <MarkdownView variant="body">{stemText(question.stem)}</MarkdownView>
          ) : null}
          <div className="px-quiz-answers">
            <div
              className={`px-quiz-answer is-${state === "flagged" ? "flagged" : state === "correct" ? "correct" : state === "partial" ? "partial" : "wrong"}`}
            >
              <p className="label">{t("quiz.yourAnswer")}</p>
              {answer ? (
                long ? (
                  <MarkdownView variant="body">{answer}</MarkdownView>
                ) : (
                  <p className="body">
                    <InlineMarkdown>{answer}</InlineMarkdown>
                  </p>
                )
              ) : (
                <p className="body px-quiz-answer-empty">{t("quiz.noAnswer")}</p>
              )}
            </div>
            {row.score < 1 || state === "flagged" ? (
              <div className="px-quiz-answer is-expected">
                <p className="label">
                  {t(long ? "quiz.reference" : "quiz.expected")}
                </p>
                {long ? (
                  <MarkdownView variant="body">{expected}</MarkdownView>
                ) : (
                  <p className="body">
                    <InlineMarkdown>{expected}</InlineMarkdown>
                  </p>
                )}
              </div>
            ) : null}
          </div>
          {row.explanation ? (
            <div className="px-quiz-explanation">
              <MarkdownView
                variant="body"
                citationResolver={(n) => row.citations[n - 1]?.label}
                onCitationClick={(n) => {
                  const cite = row.citations[n - 1];
                  if (cite) openSourceViewer({ passageId: cite.passageId });
                }}
              >
                {row.explanation}
              </MarkdownView>
            </div>
          ) : null}
          <div className="px-quiz-row-actions">
            {row.score < 1 && !row.flagged ? (
              <Button type="text" shape="round" size="small" onClick={onAsk}>
                {t("ask.askTutor")}
              </Button>
            ) : null}
            {row.flagged ? (
              <>
                <span className="small px-quiz-flag-note">
                  {t("quiz.wrongDone")}
                </span>
                <Button
                  type="text"
                  shape="round"
                  size="small"
                  disabled={busy}
                  onClick={() => onWrong(false)}
                >
                  {t("quiz.wrongUndo")}
                </Button>
              </>
            ) : (
              <Button
                type="text"
                shape="round"
                size="small"
                className="px-quiz-wrong"
                icon={<Icon name="flag" size={14} />}
                disabled={busy}
                onClick={() => onWrong(true)}
              >
                {t("quiz.wrongQuestion")}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
}
