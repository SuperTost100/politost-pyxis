import { useQuery } from "@tanstack/react-query";
import { Button } from "antd";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon, type IconName } from "../../components/Icon";
import { InlineMarkdown } from "../../components/InlineMarkdown";
import { MarkdownView } from "../../components/MarkdownView";
import { SegmentedTabs } from "../../components/SegmentedTabs";
import { openSourceViewer } from "../../components/SourceViewer";
import type { RequestOutput } from "@shared/ipc";
import { invoke } from "../../lib/ipc";
import { useGradeScale, type GradeFormat } from "../../lib/useGradeScale";
import { stemText, type Citation } from "./quizText";
import "./ResultsScreen.css";

/** Where one answer stands: graded (four ways), or still waiting for its grade. */
export type ResultMark =
  | "correct"
  | "partial"
  | "wrong"
  | "flagged"
  | "grading"
  | "queued"
  | "ungraded";

export type ResultItem = {
  id: string;
  stem: string;
  topic?: string;
  mark: ResultMark;
  /** The grade of a partly right answer or of an exercise, next to its word. */
  score?: string;
  answer: string;
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

const MARK_ICON: Record<ResultMark, IconName> = {
  correct: "circle-check",
  partial: "circle-dot",
  wrong: "circle-x",
  flagged: "flag",
  grading: "loader-circle",
  queued: "circle-dashed",
  ungraded: "circle-dashed",
};

const MARK_WORD: Record<ResultMark, string> = {
  correct: "quiz.correct",
  partial: "quiz.partial",
  wrong: "quiz.incorrect",
  flagged: "quiz.excluded",
  grading: "results.grading",
  queued: "results.queued",
  ungraded: "results.ungraded",
};

const TO_REVIEW = new Set<ResultMark>(["partial", "wrong", "flagged"]);

type Filter = "review" | "right" | "all";

/**
 * The one results screen of quizzes and simulations. The summary on the left holds the grade against the goal, what
 * the attempt changed in the path and the screen's one primary action; the answers scroll on the right, those to
 * review open, the right ones folded to a row. While grading runs, the grade waits and each answer says where it is.
 */
export function ResultsScreen({
  kind,
  attemptId,
  eyebrow,
  grade,
  headline,
  detail,
  goal,
  grading,
  notes,
  topics,
  topicsLabel,
  primary,
  secondary,
  extra,
  after,
  items,
  listNote,
}: {
  kind: "quiz" | "simulation";
  attemptId: string;
  eyebrow: string;
  /** The grade from 0 to 1. Absent while grading runs. */
  grade?: number;
  headline: string;
  detail?: string;
  /** The exam's goal from 0 to 1, marked on the grade's bar. */
  goal?: number;
  grading?: { done: number; total: number };
  /** Notices about the grade: who graded it, an engine that answered instead, a grading that stopped. */
  notes?: ReactNode;
  topics: ResultTopic[];
  topicsLabel: string;
  /** The screen's only primary button: the next step. */
  primary: ReactNode;
  secondary?: ReactNode;
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
  const graded = grade !== undefined;
  const outcome = useQuery({
    // Asked again as grading moves (an engine may answer instead) and once the grade is in.
    queryKey: ["attempt-outcome", attemptId, graded, grading?.done],
    enabled: Boolean(attemptId),
    queryFn: () => invoke("study.attemptOutcome", { attemptId }),
  });
  const reviewCount = items.filter((item) => TO_REVIEW.has(item.mark)).length;
  const rightCount = items.filter((item) => item.mark === "correct").length;
  // Until the student picks one, the filter opens on the answers to review, or on all of them when none is wrong.
  const [picked, setFilter] = useState<Filter | null>(null);
  const filter: Filter = picked ?? (reviewCount ? "review" : "all");
  // Answers to review start open, right ones folded; the student's own toggles win.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (item: ResultItem) => open[item.id] ?? TO_REVIEW.has(item.mark);
  const numbered = items.map((item, index) => ({ item, number: index + 1 }));
  const shown = graded
    ? numbered.filter(({ item }) =>
        filter === "all"
          ? true
          : filter === "review"
            ? TO_REVIEW.has(item.mark)
            : item.mark === "correct",
      )
    : numbered;
  const right = numbered.filter(({ item }) => item.mark === "correct");
  const exercise = kind === "simulation";
  const fallback = outcome.data?.fallback;
  return (
    <div className="px-res">
      <aside className="px-res-summary" aria-label={t("results.summary")}>
        <p className="small px-res-eyebrow">{eyebrow}</p>
        <Grade grade={grade} goal={goal} scale={scale} />
        <p className="body px-res-headline" role="status">
          <strong>{headline}</strong>
          {detail ? <span className="px-res-detail"> {detail}</span> : null}
        </p>
        {graded ? (
          <GradeMeter grade={grade} goal={goal} scale={scale} />
        ) : grading ? (
          <div
            className="px-res-meter is-progress"
            role="progressbar"
            aria-label={t("results.gradingProgress")}
            aria-valuemin={0}
            aria-valuemax={grading.total}
            aria-valuenow={grading.done}
          >
            <span
              className="px-res-meter-fill"
              style={{
                width: `${Math.round((grading.done / Math.max(1, grading.total)) * 100)}%`,
              }}
            />
          </div>
        ) : null}
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
        <Changes
          graded={graded}
          goal={goal}
          outcome={outcome.data}
          scale={scale}
        />
        <div className="px-res-actions">
          {primary}
          {secondary}
        </div>
        {extra ? <div className="px-res-extra">{extra}</div> : null}
        {after ? <p className="small px-res-after">{after}</p> : null}
        {topics.length ? (
          <section className="px-res-topics" aria-label={topicsLabel}>
            <h2 className="small px-res-topics-title">{topicsLabel}</h2>
            <ul>
              {topics.map((topic) => {
                const low = topic.share < 0.5;
                return (
                  <li key={topic.id} className={low ? "is-low" : undefined}>
                    <span className="px-res-topic-name">
                      {low ? <Icon name="circle-alert" size={16} /> : null}
                      <span>
                        {topic.title}
                        {topic.level ? (
                          <span className="px-res-topic-level">{topic.level}</span>
                        ) : null}
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
        <div className="px-res-filter">
          {graded && items.length ? (
            <SegmentedTabs
              label={t(exercise ? "results.filterExercises" : "results.filterQuestions")}
              value={filter}
              onChange={(value) => setFilter(value as Filter)}
              items={[
                { value: "review", label: t("results.toReview"), badge: String(reviewCount) },
                {
                  value: "right",
                  label: t(exercise ? "results.fullMarks" : "results.right"),
                  badge: String(rightCount),
                },
                {
                  value: "all",
                  label: t(exercise ? "results.allExercises" : "results.all"),
                  badge: String(items.length),
                },
              ]}
            />
          ) : null}
          <h2
            id={`${attemptId}-answers`}
            className={graded && items.length ? "visually-hidden" : "title-3 px-res-list-title"}
          >
            {t(exercise ? "results.exercises" : "quiz.questions")}
          </h2>
          {listNote ? <span className="small px-res-list-note">{listNote}</span> : null}
        </div>
        {shown.length ? (
          <ol className="px-res-qs">
            {shown.map(({ item, number }) => (
              <Question
                key={item.id}
                item={item}
                number={number}
                open={isOpen(item)}
                onToggle={() =>
                  setOpen((current) => ({ ...current, [item.id]: !isOpen(item) }))
                }
              />
            ))}
            {filter === "review" && graded && right.length ? (
              <li className="px-res-fold">
                <Icon name="circle-check" size={18} />
                <span className="body">
                  {t(exercise ? "results.foldFull" : "results.foldRight", {
                    count: right.length,
                    list: right.map(({ number }) => number).join(", "),
                  })}
                </span>
                <Button type="text" shape="round" size="small" onClick={() => setFilter("right")}>
                  {t("results.show")}
                </Button>
              </li>
            ) : null}
          </ol>
        ) : items.length ? (
          <p className="body px-res-empty">
            {t(
              filter === "review"
                ? "results.noneToReview"
                : exercise
                  ? "results.noneFull"
                  : "results.noneRight",
            )}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function Grade({
  grade,
  goal,
  scale,
}: {
  grade?: number;
  goal?: number;
  scale: GradeFormat;
}) {
  const { t } = useTranslation();
  return (
    <p className="px-res-grade">
      {grade === undefined ? (
        <span className="px-res-grade-wait" aria-hidden />
      ) : (
        <span className="px-res-grade-num" aria-hidden>
          {scale.number(grade)}
        </span>
      )}
      <span className="px-res-grade-scale" aria-hidden>
        /{scale.scale}
      </span>
      <span className="visually-hidden">
        {grade === undefined
          ? t("results.gradeWaiting")
          : goal !== undefined
            ? t("results.gradeGoal", { grade: scale.format(grade), goal: scale.format(goal) })
            : t("results.gradeOnly", { grade: scale.format(grade) })}
      </span>
    </p>
  );
}

function GradeMeter({
  grade,
  goal,
  scale,
}: {
  grade: number;
  goal?: number;
  scale: GradeFormat;
}) {
  const { t } = useTranslation();
  const pass = scale.scale === 30 ? 18 : undefined;
  return (
    <div className="px-res-scale-wrap">
      <div
        className="px-res-meter"
        role="meter"
        aria-label={t("results.grade")}
        aria-valuemin={0}
        aria-valuemax={scale.scale}
        aria-valuenow={scale.value(grade)}
        aria-valuetext={
          goal !== undefined
            ? t("results.gradeGoal", { grade: scale.format(grade), goal: scale.format(goal) })
            : scale.format(grade)
        }
      >
        <span
          className="px-res-meter-fill"
          style={{ width: `${Math.round(Math.max(0, Math.min(1, grade)) * 1000) / 10}%` }}
        />
        {goal !== undefined ? (
          <span className="px-res-goal" style={{ left: `${Math.round(goal * 1000) / 10}%` }} />
        ) : null}
      </div>
      <div className="meta px-res-scale" aria-hidden>
        <span>0</span>
        {pass ? (
          <span style={{ left: `${(pass / scale.scale) * 100}%` }} className="is-pass">
            {pass}
          </span>
        ) : null}
        <span className="is-end">{scale.scale}</span>
      </div>
      {goal !== undefined ? (
        <p className="small px-res-goal-note">
          <span className="px-res-goal-key" aria-hidden />
          {t("results.goal", { goal: scale.format(goal) })}
        </p>
      ) : null}
    </div>
  );
}

type Outcome = RequestOutput<"study.attemptOutcome">;

/** At most this many changes; the topic list below has the rest. */
const MAX_CHANGES = 4;

/** What the attempt changed in the path: the gaps its answers count for, then topics it moved. Only what the app knows. */
function Changes({
  graded,
  goal,
  outcome,
  scale,
}: {
  graded: boolean;
  goal?: number;
  outcome?: Outcome;
  scale: GradeFormat;
}) {
  const { t } = useTranslation();
  const title = useId();
  if (!graded)
    return (
      <section className="px-res-changes" aria-labelledby={title}>
        <h2 id={title} className="small px-res-changes-title">
          {t("results.changes")}
        </h2>
        <div className="px-res-skeleton" aria-hidden>
          <span />
          <span className="is-short" />
        </div>
        <p className="small px-res-changes-later">{t("results.changesLater")}</p>
      </section>
    );
  if (!outcome) return null;
  // A step on the grade's scale is the smallest change the student can see; smaller moves are left out.
  const moved = outcome.topics.filter(
    (topic) => scale.masteryNumber(topic.before) !== scale.masteryNumber(topic.after),
  );
  const gapTopics = new Set(
    outcome.gaps.filter((gap) => gap.open).map((gap) => gap.topicId),
  );
  const rows: Array<{
    key: string;
    icon: IconName;
    tone: "danger" | "mastery" | "primary";
    what: string;
    why?: string;
    values?: string;
  }> = [];
  const titleOf = (topicId: string) =>
    outcome.topics.find((topic) => topic.id === topicId)?.title;
  const values = (topicId: string) => {
    const topic = moved.find((row) => row.id === topicId);
    return topic
      ? `${scale.masteryNumber(topic.before)} → ${scale.mastery(topic.after)}`
      : undefined;
  };
  for (const gap of outcome.gaps) {
    if (!gap.open) continue;
    const name = titleOf(gap.topicId);
    // A gap on a topic this attempt did not move has no title here; the topic list names it.
    if (!name || rows.some((row) => row.key === gap.topicId)) continue;
    rows.push({
      key: gap.topicId,
      icon: "target",
      tone: "danger",
      what: t(gap.severity === "severe" ? "results.gapSevere" : "results.gap", {
        topic: name,
      }),
      why: gap.misconception ?? undefined,
      values: values(gap.topicId),
    });
  }
  for (const topic of [...moved].sort(
    (a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before),
  )) {
    if (gapTopics.has(topic.id)) continue;
    const reached =
      goal !== undefined && topic.before < goal && topic.after >= goal;
    const up = topic.after > topic.before;
    rows.push({
      key: topic.id,
      icon: reached ? "circle-check" : up ? "trending-up" : "trending-down",
      tone: reached ? "mastery" : up ? "primary" : "danger",
      what: t(reached ? "results.reached" : up ? "results.up" : "results.down", {
        topic: topic.title,
      }),
      values: values(topic.id),
    });
  }
  if (!rows.length) return null;
  return (
    <section className="px-res-changes" aria-labelledby={title}>
      <h2 id={title} className="small px-res-changes-title">
        {t("results.changes")}
      </h2>
      <ul>
        {rows.slice(0, MAX_CHANGES).map((row) => (
          <li key={row.key}>
            <Icon name={row.icon} size={20} className={`is-${row.tone}`} />
            <div>
              <p className="body-strong px-res-change-what">{row.what}</p>
              {row.why ? <p className="small px-res-change-why">{row.why}</p> : null}
              {row.values ? <p className="meta px-res-change-values">{row.values}</p> : null}
            </div>
          </li>
        ))}
      </ul>
      {rows.some((row) => row.values) ? (
        <p className="small px-res-changes-later">{t("results.changesNote")}</p>
      ) : null}
    </section>
  );
}

function Question({
  item,
  number,
  open,
  onToggle,
}: {
  item: ResultItem;
  number: number;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const body = useId();
  const word = t(MARK_WORD[item.mark]);
  const waiting = item.mark === "grading" || item.mark === "queued" || item.mark === "ungraded";
  const head = (
    <>
      <span className="px-res-mark">
        <Icon
          name={MARK_ICON[item.mark]}
          size={18}
          strokeWidth={2}
          className={item.mark === "grading" ? "px-res-spin" : undefined}
        />
      </span>
      <span className="meta px-res-n">{number}</span>
      <span className="px-res-stem">
        <InlineMarkdown>{stemText(item.stem)}</InlineMarkdown>
      </span>
      <span className="small px-res-meta">
        {item.topic ? <span className="px-res-topic">{item.topic}</span> : null}
        <span className="px-res-word">
          {word}
          {item.score ? `, ${item.score}` : ""}
        </span>
      </span>
    </>
  );
  return (
    <li className={`px-res-q is-${item.mark}${open && !waiting ? " is-open" : ""}`}>
      {waiting ? (
        <div className="px-res-q-head is-static">
          {head}
          <span />
        </div>
      ) : (
        <button
          type="button"
          className="px-res-q-head"
          aria-expanded={open}
          aria-controls={body}
          onClick={onToggle}
        >
          {head}
          <Icon name="chevron-down" size={18} className="px-res-chevron" />
        </button>
      )}
      {open && !waiting ? <Answer id={body} item={item} /> : null}
    </li>
  );
}

function Answer({ id, item }: { id: string; item: ResultItem }) {
  const { t } = useTranslation();
  const right = item.mark === "correct";
  const showExpected = !right && item.expected !== undefined;
  const text = (value: string) =>
    item.long ? (
      <MarkdownView variant="body">{value}</MarkdownView>
    ) : (
      <p className="body">
        <InlineMarkdown>{value}</InlineMarkdown>
      </p>
    );
  return (
    <div id={id} className="px-res-q-body">
      {/\n|\$\$/.test(item.stem) ? (
        <MarkdownView variant="body">{stemText(item.stem)}</MarkdownView>
      ) : null}
      <div className={`px-res-answers${item.long ? " is-long" : ""}`}>
        <div className={`px-res-answer is-yours is-${item.mark}`}>
          <p className="small px-res-answer-label">
            <Icon name={right ? "check" : item.mark === "flagged" ? "flag" : "x"} size={16} />
            {t("quiz.yourAnswer")}
          </p>
          {item.answer ? (
            text(item.answer)
          ) : (
            <p className="body px-res-answer-empty">{t("quiz.noAnswer")}</p>
          )}
        </div>
        {showExpected ? (
          <div className="px-res-answer is-expected">
            <p className="small px-res-answer-label">
              <Icon name="check" size={16} />
              {item.expectedLabel}
            </p>
            {text(item.expected ?? "")}
          </div>
        ) : null}
      </div>
      {item.explanation || item.missed?.length ? (
        <div className="px-res-missing">
          <p className="small px-res-missing-label">
            {t(right ? "results.why" : "simulation.missed")}
          </p>
          {item.explanation ? (
            <MarkdownView
              variant="body"
              citationResolver={(n) => item.citations?.[n - 1]?.label}
              onCitationClick={(n) => {
                const cite = item.citations?.[n - 1];
                if (cite) openSourceViewer({ passageId: cite.passageId });
              }}
            >
              {item.explanation}
            </MarkdownView>
          ) : null}
          {item.missed?.length ? (
            <ul>
              {item.missed.map((line, index) => (
                <li key={index}>
                  <MarkdownView variant="body">{line}</MarkdownView>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {item.grader || item.onAsk || item.wrong ? (
        <div className="px-res-q-foot">
          {item.grader ? (
            <span className="small px-res-grader">
              {t("quiz.gradedBy", { model: item.grader })}
            </span>
          ) : null}
          <span className="px-res-grow" />
          {item.mark === "flagged" ? (
            <span className="small px-res-flag-note">{t("quiz.wrongDone")}</span>
          ) : null}
          {item.onAsk && !right && item.mark !== "flagged" ? (
            <Button type="text" shape="round" size="small" onClick={item.onAsk}>
              {t("ask.askTutor")}
            </Button>
          ) : null}
          {item.wrong ? (
            item.mark === "flagged" ? (
              <Button
                type="text"
                shape="round"
                size="small"
                disabled={item.wrong.busy}
                onClick={() => item.wrong?.onChange(false)}
              >
                {t("quiz.wrongUndo")}
              </Button>
            ) : (
              <Button
                type="text"
                shape="round"
                size="small"
                icon={<Icon name="flag" size={14} />}
                disabled={item.wrong.busy}
                onClick={() => item.wrong?.onChange(true)}
              >
                {t("quiz.wrongQuestion")}
              </Button>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
