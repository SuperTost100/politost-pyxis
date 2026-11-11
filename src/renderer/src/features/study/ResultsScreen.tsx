import { useQuery } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Button } from "../../components/Button";
import { Icon, type IconName } from "../../components/Icon";
import { InlineMarkdown } from "../../components/InlineMarkdown";
import { Logo } from "../../components/Logo";
import { openMakeCards } from "../../components/MakeCardsDialog";
import { MarkdownView } from "../../components/MarkdownView";
import { openSourceViewer } from "../../components/SourceViewer";
import type { RequestOutput } from "@shared/ipc";
import { invoke } from "../../lib/ipc";
import { useGradeScale, type GradeFormat } from "../../lib/useGradeScale";
import { questionPoints, stemText, type AnswerSource, type Citation } from "./quizText";
import { drillGap, tally, type ResultMark } from "./resultsSummary";
import { TypedAnswer } from "./TypedAnswer";
import "./ResultsScreen.css";

export type { ResultMark };

export type ResultItem = {
  id: string;
  stem: string;
  topic?: string;
  mark: ResultMark;
  /** The answer's credit from 0 to 1, once graded: "0,5/1" beside its word. */
  value?: number;
  /** The grade of a partly right answer or of an exercise, in words. */
  score?: string;
  answer: string;
  /** Set when the student wrote the answer, so it shows as written, not as Markdown. See `answerSource`. */
  typed?: AnswerSource;
  /** Open answers and exercises: Markdown, the two answers one under the other. */
  long: boolean;
  expected?: string;
  expectedLabel: string;
  /** The grader's explanation of what is missing (or why it is right). */
  explanation?: string;
  missed?: string[];
  citations?: Citation[];
  /** The engine and model that graded it. */
  grader?: string;
  onAsk?: () => void;
  /** "Wrong question?": quizzes only. */
  wrong?: { busy: boolean; onChange: (wrong: boolean) => void };
};

export type ResultTopic = {
  id: string;
  title: string;
  /** From 0 to 1, for the bar. */
  share: number;
  value: string;
  /** A diagnostic says where to start: a word for each topic. */
  level?: string;
};

type Outcome = RequestOutput<"study.attemptOutcome">;

/**
 * The one results screen of quizzes and simulations. On the left the grade is the title, in words, with the count of
 * right and wrong answers, the topics it moved, what changes in the path and the one next step, Ripasso mirato when
 * something is to review. On the right every question in the order it was asked: the right ones folded to a line with
 * the quiet green "Giusta", the others open with the right answer, the explanation and its sources. While an AI tool
 * grades the answers, the title and each answer waiting for it show the work in place.
 */
export function ResultsScreen({
  kind,
  attemptId,
  planId,
  eyebrow,
  grade,
  headline,
  detail,
  goal,
  grading,
  stopped = false,
  notes,
  topics,
  topicsLabel,
  primary,
  secondary,
  review,
  extra,
  after,
  items,
  listNote,
}: {
  kind: "quiz" | "simulation";
  attemptId: string;
  planId: string;
  eyebrow: string;
  /** The grade from 0 to 1. Absent while grading runs. */
  grade?: number;
  /** While grading runs, what is happening. Once graded the title says the grade. */
  headline: string;
  detail?: string;
  /** The exam's goal from 0 to 1: a topic that crosses it says so. */
  goal?: number;
  grading?: { done: number; total: number };
  /** Grading stopped before the end: the title says so and the mark stands still; `notes` says why and how to go on. */
  stopped?: boolean;
  /** Notices about the grade: who graded it, an engine that answered instead, a grading that stopped. */
  notes?: ReactNode;
  topics: ResultTopic[];
  topicsLabel: string;
  /** The next step when nothing is to review, or while grading runs. */
  primary?: ReactNode;
  secondary?: ReactNode;
  /** Something is to review: Ripasso mirato is the next step, and `onReview` asks the wrong ones again. */
  review?: { count: number; onReview: () => void };
  /** Quiet actions on the whole attempt, such as export and redo. */
  extra?: ReactNode;
  /** A line under the actions. */
  after?: ReactNode;
  items: ResultItem[];
  /** Beside the list's heading while grading runs: who is grading. */
  listNote?: ReactNode;
}) {
  const { t } = useTranslation();
  const scale = useGradeScale();
  const navigate = useNavigate();
  const graded = grade !== undefined;
  const outcome = useQuery({
    // Asked again as grading moves (an engine may answer instead) and once the grade is in. Marked stale by the key's first
    // two parts when a gap-insight job ends (`jobInvalidation`) and when a question is marked wrong (`QuizPage`).
    queryKey: ["attempt-outcome", attemptId, graded, grading?.done],
    enabled: Boolean(attemptId),
    queryFn: () => invoke("study.attemptOutcome", { attemptId }),
  });
  const exercise = kind === "simulation";
  // Ripasso mirato opens the gap's drill or, without a gap, the wrong answers, and "Rifai solo le N" exists only with a
  // gap. Until the outcome says which, neither is offered, so a click never lands on the other one and nothing that is
  // shown goes away. A read that failed leaves `gap` empty, and the page goes on without it.
  const deciding = graded && Boolean(review) && outcome.isPending;
  const fallback = outcome.data?.fallback;
  const gap = graded && outcome.data ? drillGap(outcome.data.gaps) : undefined;
  const gapTopic = gap ? outcome.data?.topics.find((topic) => topic.id === gap.topicId)?.title : undefined;
  const parts = tally(items.map((item) => item.mark));
  const titleId = useId();
  return (
    <div className="px-res">
      <aside className="px-res-summary" aria-labelledby={titleId}>
        <p className="small px-res-eyebrow">{eyebrow}</p>
        {graded ? (
          <h2 id={titleId} className="px-res-title">
            {t("results.took", { grade: scale.format(grade) })}
          </h2>
        ) : (
          <div className="px-res-working">
            <Logo working={!stopped} decorative size={22} />
            <h2 id={titleId} className="px-res-title is-working">
              {stopped ? t("results.stoppedHeadline") : headline}
            </h2>
          </div>
        )}
        {!graded && grading?.total ? (
          <div
            className="px-res-progress"
            role="progressbar"
            aria-label={t("results.gradingProgress")}
            aria-valuemin={0}
            aria-valuemax={grading.total}
            aria-valuenow={grading.done}
          >
            <span style={{ width: `${Math.round((grading.done / grading.total) * 100)}%` }} />
          </div>
        ) : null}
        <p className="px-res-headline" role="status">
          {graded && parts.length ? (
            <span className="px-res-tally">
              {parts.map((part) => t(`results.tally.${part.key}`, { count: part.count })).join(", ")}
              {". "}
            </span>
          ) : null}
          {detail ? <span className="px-res-detail">{detail}</span> : null}
        </p>
        {graded && outcome.data ? <Rises outcome={outcome.data} goal={goal} scale={scale} /> : null}
        {notes || fallback ? (
          <div className="px-res-notes">
            {fallback ? (
              <p className="small px-res-fallback">
                <Icon name="info" size={16} />
                <span>
                  {t(`engines.fallback.${fallback.reason}`, {
                    from: fallback.from,
                    to: fallback.to,
                  })}
                </span>
              </p>
            ) : null}
            {notes}
          </div>
        ) : null}
        {!graded ? (
          <section className="px-res-changes" aria-labelledby={`${titleId}-changes`}>
            <h3 id={`${titleId}-changes`} className="px-res-changes-title">
              {t("results.changes")}
            </h3>
            <p className="px-res-changes-text">{t("results.changesLater")}</p>
          </section>
        ) : gap ? (
          <section className="px-res-changes" aria-labelledby={`${titleId}-changes`}>
            <h3 id={`${titleId}-changes`} className="px-res-changes-title">
              {t("results.changes")}
            </h3>
            {gap.misconception ? <p className="px-res-changes-text">{gap.misconception}</p> : null}
            <div className="px-res-newstep">
              <Icon name="rotate-ccw" size={18} />
              <div>
                <b>{t("results.newStep")}</b>
                <span>
                  {[gapTopic, t(gap.severity === "severe" ? "results.gapSevereShort" : "results.gapShort")]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
            </div>
          </section>
        ) : null}
        <div className="px-res-actions" aria-busy={deciding || undefined}>
          {deciding ? (
            <div className="px-skeleton px-res-wait" role="status">
              <span className="visually-hidden">{t("results.reviewLoading")}</span>
              <i className="px-skeleton-bar is-primary" aria-hidden />
              <i className="px-skeleton-bar" aria-hidden />
            </div>
          ) : graded && review ? (
            <>
              <Button
                size="lg"
                block
                onClick={() =>
                  gap ? navigate(`/plans/${planId}?drill=${encodeURIComponent(gap.topicId)}`) : review.onReview()
                }
              >
                {t("results.targeted")}
              </Button>
              {gap ? (
                <Button variant="ghost" block onClick={review.onReview}>
                  {t("results.redoWrong", { count: review.count })}
                </Button>
              ) : null}
            </>
          ) : (
            primary
          )}
          {secondary}
        </div>
        {extra ? <div className="px-res-extra">{extra}</div> : null}
        {after ? <p className="small px-res-after">{after}</p> : null}
        {topics.length ? (
          <section className="px-res-topics" aria-labelledby={`${titleId}-topics`}>
            <h3 id={`${titleId}-topics`} className="px-res-changes-title">
              {topicsLabel}
            </h3>
            <ul>
              {topics.map((topic) => {
                const low = topic.share < 0.5;
                return (
                  <li key={topic.id} className={low ? "is-low" : undefined}>
                    <span className="px-res-topic-name">
                      {low ? <Icon name="circle-alert" size={16} /> : null}
                      <span>
                        {topic.title}
                        {topic.level ? <span className="px-res-topic-level">{topic.level}</span> : null}
                      </span>
                    </span>
                    <span className="px-res-bar" aria-hidden>
                      <span style={{ width: `${Math.round(topic.share * 100)}%` }} />
                    </span>
                    <span className="meta px-res-topic-value">{topic.value}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </aside>
      <section className="px-res-list" aria-labelledby={`${attemptId}-answers`}>
        <div className="px-res-list-head">
          <h2 id={`${attemptId}-answers`} className="px-res-list-title">
            {t(exercise ? "results.exercisesCount" : "results.questionsCount", { count: items.length })}
          </h2>
          {listNote ? <span className="small px-res-list-note">{listNote}</span> : null}
        </div>
        <ol className="px-res-qs">
          {items.map((item, index) => (
            <Question key={item.id} item={item} number={index + 1} planId={planId} />
          ))}
        </ol>
      </section>
    </div>
  );
}

/** The topics the attempt moved by at least one step on the grade's scale, each with where it was and where it is. */
function Rises({ outcome, goal, scale }: { outcome: Outcome; goal?: number; scale: GradeFormat }) {
  const { t } = useTranslation();
  const moved = outcome.topics
    .filter((topic) => scale.masteryNumber(topic.before) !== scale.masteryNumber(topic.after))
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))
    .slice(0, 3);
  if (!moved.length) return null;
  return (
    <ul className="px-res-rises">
      {moved.map((topic) => {
        const up = topic.after > topic.before;
        const reached = goal !== undefined && topic.before < goal && topic.after >= goal;
        return (
          <li key={topic.id}>
            <Icon name={reached ? "circle-check" : up ? "trending-up" : "trending-down"} size={16} />
            <span>
              {t(reached ? "results.riseReached" : up ? "results.rise" : "results.fall", {
                topic: topic.title,
                before: scale.mastery(topic.before),
                after: scale.mastery(topic.after),
              })}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const STATUS_ICON: Record<Exclude<ResultMark, "grading">, IconName> = {
  correct: "check",
  partial: "contrast",
  wrong: "circle-x",
  flagged: "flag",
  queued: "circle-dashed",
  ungraded: "circle-dashed",
};

const STATUS_WORD: Record<ResultMark, string> = {
  correct: "results.right",
  partial: "results.half",
  wrong: "results.wrong",
  flagged: "quiz.excluded",
  grading: "results.grading",
  queued: "results.queued",
  ungraded: "results.ungraded",
};

/** The answer's state in a word, its icon and its points: "Giusta · 1/1" in the quiet green, the others in ink. */
function Status({ item }: { item: ResultItem }) {
  const { t, i18n } = useTranslation();
  const dontKnow = item.mark === "wrong" && !item.answer;
  const word = t(dontKnow ? "results.dontKnow" : STATUS_WORD[item.mark]);
  const points =
    item.value !== undefined && item.mark !== "flagged" && item.mark !== "grading" && item.mark !== "queued"
      ? `${questionPoints(item.value, i18n.language)}/1`
      : undefined;
  return (
    <span className={`px-res-st is-${item.mark}`}>
      {item.mark === "grading" ? (
        <Logo working decorative size={16} />
      ) : (
        <Icon name={STATUS_ICON[item.mark]} size={16} strokeWidth={2} />
      )}
      {points ? `${word} · ${points}` : word}
    </span>
  );
}

function Question({ item, number, planId }: { item: ResultItem; number: number; planId: string }) {
  const body = useId();
  const [open, setOpen] = useState(false);
  const right = item.mark === "correct";
  if (right)
    return (
      <li className={`px-res-q is-correct${open ? " is-open" : ""}`}>
        <button
          type="button"
          className="px-res-q-head"
          aria-expanded={open}
          aria-controls={body}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="px-res-q-line">
            <span className="px-res-n">{number}</span>
            {" · "}
            <InlineMarkdown>{stemText(item.stem)}</InlineMarkdown>
          </span>
          <Status item={item} />
          <Icon name="chevron-down" size={16} className="px-res-chevron" />
        </button>
        {open ? <Answer id={body} item={item} planId={planId} /> : null}
      </li>
    );
  return (
    <li className={`px-res-q is-${item.mark} is-open`}>
      <div className="px-res-q-head is-static">
        <b className="px-res-q-line">
          <span className="px-res-n">{number}</span>
          {item.topic ? ` · ${item.topic}` : ""}
        </b>
        <Status item={item} />
      </div>
      <Answer id={body} item={item} planId={planId} />
    </li>
  );
}

function Answer({ id, item, planId }: { id: string; item: ResultItem; planId: string }) {
  const { t } = useTranslation();
  const right = item.mark === "correct";
  const waiting = item.mark === "grading" || item.mark === "queued" || item.mark === "ungraded";
  const showExpected = !right && !waiting && Boolean(item.expected);
  const text = (value: string, written?: AnswerSource) =>
    written ? (
      <TypedAnswer text={value} source={written} />
    ) : item.long ? (
      <MarkdownView variant="body">{value}</MarkdownView>
    ) : (
      <InlineMarkdown>{value}</InlineMarkdown>
    );
  const citations = item.citations ?? [];
  // A source the explanation cites is a chip in its text; the row under it lists only the others.
  const inline = new Set([...(item.explanation ?? "").matchAll(/\[P(\d+)\]/g)].map((match) => Number(match[1]) - 1));
  const listed = citations.filter((_, index) => !inline.has(index));
  return (
    <div id={id} className="px-res-q-body">
      <div className="px-res-stem">
        <MarkdownView variant="body">{stemText(item.stem)}</MarkdownView>
      </div>
      <dl className={`px-res-ans${item.long ? " is-long" : ""}`}>
        <dt>{t("quiz.yourAnswer")}</dt>
        <dd className={`px-res-answer is-yours is-${item.mark}`}>
          {item.answer ? (
            text(item.answer, item.typed)
          ) : (
            <span className="px-res-answer-empty">{t(waiting ? "quiz.noAnswer" : "results.dontKnowAnswer")}</span>
          )}
        </dd>
        {showExpected ? (
          <>
            <dt>{item.expectedLabel}</dt>
            <dd className="px-res-answer is-expected">
              <span className="px-res-ok-a">
                {text(item.expected ?? "")}
                <Icon name="check" size={16} strokeWidth={2} />
              </span>
            </dd>
          </>
        ) : null}
      </dl>
      {waiting ? null : item.explanation || item.missed?.length ? (
        <div className="px-res-why">
          {item.explanation ? (
            <MarkdownView
              variant="body"
              citationResolver={(n) => citations[n - 1]?.label}
              onCitationClick={(n) => {
                const cite = citations[n - 1];
                if (cite) openSourceViewer({ passageId: cite.passageId });
              }}
            >
              {item.explanation}
            </MarkdownView>
          ) : null}
          {item.missed?.length ? (
            <>
              <p className="small px-res-missing-label">{t("simulation.missed")}</p>
              <ul>
                {item.missed.map((line, index) => (
                  <li key={index}>
                    <MarkdownView variant="body">{line}</MarkdownView>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
      {waiting ? null : (
        <div className="px-res-acts">
          {listed.map((cite) => (
            <button
              key={cite.passageId}
              type="button"
              className="px-res-src"
              onClick={() => openSourceViewer({ passageId: cite.passageId })}
            >
              <Icon name="book-open" size={16} />
              {cite.label}
            </button>
          ))}
          {item.grader ? <span className="small px-res-grader">{t("quiz.gradedBy", { model: item.grader })}</span> : null}
          <span className="px-res-grow" />
          {item.mark === "flagged" ? <span className="small px-res-flag-note">{t("quiz.wrongDone")}</span> : null}
          {item.wrong ? (
            <Button
              variant="ghost"
              size="sm"
              icon={item.mark === "flagged" ? undefined : "flag"}
              disabled={item.wrong.busy}
              onClick={() => item.wrong?.onChange(item.mark !== "flagged")}
            >
              {t(item.mark === "flagged" ? "quiz.wrongUndo" : "quiz.wrongQuestion")}
            </Button>
          ) : null}
          {!right && item.mark !== "flagged" ? (
            <Button
              variant="ghost"
              size="sm"
              icon="layers"
              onClick={() =>
                openMakeCards({
                  text: [stemText(item.stem), item.expected ? `${item.expectedLabel}: ${item.expected}` : "", item.explanation ?? ""]
                    .filter(Boolean)
                    .join("\n\n"),
                  origin: "reply",
                  planId,
                  passageIds: citations.map((cite) => cite.passageId),
                })
              }
            >
              {t("results.makeCard")}
            </Button>
          ) : null}
          {item.onAsk && !right && item.mark !== "flagged" ? (
            <Button variant="secondary" size="sm" icon="message-circle" onClick={item.onAsk}>
              {t("results.ask")}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
