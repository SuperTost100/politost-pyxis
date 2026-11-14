import { Fragment, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { Button } from "../../components/Button";
import { Icon, type IconName } from "../../components/Icon";
import { InlineMarkdown } from "../../components/InlineMarkdown";
import { MathText } from "../../components/math/MathText";
import { Logo } from "../../components/Logo";
import { Notice } from "../../components/Notice";
import { useGradeScale } from "../../lib/useGradeScale";
import { partsQuery, plannerQuery } from "../../lib/queries";
import {
  needsWeeklyHours,
  reopensFinished,
  topicRows,
  type StepChip,
  type TopicRow,
} from "./pathRows";
import { keepsLessonStep, partPath, partsHeading, partsLine, type Outline } from "./partsText";
import { reopenPath, stepPath } from "./reopen";
import type { useGapDrill } from "./useGapDrill";
import "./PlanPath.css";

type Plan = NonNullable<RequestOutput<"plans.read">>;
type Guide = NonNullable<RequestOutput<"plans.recommend">>;
type Schedule = RequestOutput<"plans.schedule">;
type Step = Plan["steps"][number];
type Activity = Step["activity"];
type Topic = Plan["topics"][number];
export type TopicAction = "map" | "viewer" | "ask" | "create";

export const activityIcons: Record<Activity, IconName> = {
  intro: "compass",
  diagnostic: "target",
  lesson: "book-open",
  practice: "pencil-line",
  quiz: "list-checks",
  cards: "layers",
  gaps: "circle-alert",
  simulation: "clock",
};
const stepIcons: Record<StepChip["state"], IconName> = {
  done: "check",
  missed: "circle-x",
  todo: "circle",
  now: "arrow-right",
};

/** "lun 9 nov" from a YYYY-MM-DD day, read as a local date. */
function shortDay(day: string, language: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Intl.DateTimeFormat(language, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(year!, month! - 1, date!));
}

/**
 * The exam's path, top to bottom: the introduction and the diagnostic while they are ahead, each topic in the order
 * the student studies it, the simulation and the exam. A topic opens to its steps; the one the path is on starts open.
 * Every step opens on a click, done or not: the order is only a suggestion.
 */
export function PlanPath({
  planId,
  plan,
  guide,
  schedule,
  drill,
  onTopicAction,
  onOpenItem,
  itemsBusy,
}: {
  planId: string;
  plan: Plan;
  guide: Guide | undefined;
  schedule: Schedule | undefined;
  drill: ReturnType<typeof useGapDrill>;
  onTopicAction: (action: TopicAction, topic: Topic) => void;
  onOpenItem: (item: Topic["items"][number], topicId: string) => void;
  itemsBusy: boolean;
}) {
  const { t, i18n } = useTranslation();
  const grade = useGradeScale();
  // A quiz's points, as the results screen writes them: partial credit keeps one decimal.
  const points = new Intl.NumberFormat(i18n.language, {
    maximumFractionDigits: 1,
  });
  const navigate = useNavigate();
  const ids = useId();
  const next = guide?.next ?? null;
  const rows = topicRows({
    topics: plan.topics,
    steps: plan.steps,
    status: guide?.topics ?? [],
    next,
    goal: plan.target,
    schedule: schedule?.topics ?? null,
  });
  const planner = useQuery(plannerQuery);
  const hoursHint = needsWeeklyHours({
    schedule,
    weeklyHours: planner.data?.weeklyHours,
    examAt: plan.examAt,
    archived: plan.archivedAt != null,
    open: rows.filter((row) => !row.atGoal).length,
    now: Date.now(),
  });
  // The topic the path is on starts open; a click opens another one instead, and a second click closes it.
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const openTopic =
    chosen === undefined
      ? (rows.find((row) => row.current)?.id ?? null)
      : chosen;
  // The open topic's lesson in parts. A topic's parts are read as the pointer or the focus reaches its row, so they are
  // usually there when it opens.
  const client = useQueryClient();
  const parts = useQuery({ ...partsQuery(planId, openTopic ?? ""), enabled: openTopic != null });
  const prefetchParts = (topicId: string) => void client.prefetchQuery(partsQuery(planId, topicId));
  // Two parts or more are listed; a one-part topic keeps its one lesson step.
  const openOutline = parts.data?.outline && parts.data.outline.parts.length > 1 ? parts.data.outline : null;
  const steps = plan.steps;
  const last = (activity: Activity) =>
    steps.filter((step) => step.activity === activity).at(-1);
  const name = (activity: Activity) => t(`plans.path.activity.${activity}`);
  const day = (value: string) => shortDay(value, i18n.language);

  function go(activity: Activity, topic: string | null) {
    const to = stepPath(planId, activity, topic);
    if (to) navigate(to);
  }
  function reopen(
    step: Step | undefined,
    activity: Activity,
    topicId: string | null = null,
  ) {
    const to = step ? reopenPath(planId, step) : null;
    if (to) navigate(to);
    else go(activity, topicId);
  }

  function when(date: string | null | undefined) {
    if (date === undefined) return null;
    return date === null
      ? t("plans.path.late")
      : t("examPage.by", { date: day(date) });
  }
  function lessonDone(row: TopicRow) {
    return row.steps.some((chip) => chip.activity === "lesson" && chip.state === "done");
  }
  function sub(row: TopicRow, outline: Outline | null) {
    if (row.atGoal)
      return row.gaps > 0
        ? t("examPage.toReview", { count: row.gaps })
        : t("plans.path.atGoal");
    // A lesson finished before it was rewritten in parts stays finished: the row keeps its usual line.
    const reading = outline && !lessonDone(row) ? partsLine(t, outline) : null;
    if (reading) return reading;
    if (row.current)
      return t("examPage.stepsDone", {
        done: row.steps.filter((chip) => chip.state === "done").length,
        count: row.steps.length,
      });
    if (row.gaps > 0) return t("plans.path.gaps", { count: row.gaps });
    const expected = when(row.date);
    if (expected) return expected;
    if (row.last)
      return t("progress.lastStudied", {
        date: new Intl.DateTimeFormat(i18n.language, {
          day: "numeric",
          month: "short",
        }).format(row.last.at),
      });
    return t("progress.neverStudied");
  }
  /** A step's score, if it has one, and its note: "adesso", what is due, or that it was done. */
  function chipParts(chip: StepChip) {
    const score = chip.result
      ? `${points.format(chip.result.correct)}/${chip.result.total}`
      : null;
    const note =
      chip.state === "now"
        ? t("examPage.nowStep")
        : chip.activity === "cards" && chip.count
          ? t("plans.path.due", { count: chip.count })
          : chip.activity === "gaps"
            ? t("plans.path.gaps", { count: chip.count ?? 0 })
            : chip.state === "done" && !score
              ? t(
                  chip.activity === "lesson"
                    ? "plans.path.result.lesson"
                    : "plans.path.result.done",
                )
              : null;
    return [score, note].filter((part): part is string => Boolean(part));
  }
  function chipMeta(chip: StepChip) {
    return chipParts(chip).join(" · ") || null;
  }
  /** "Quiz, 6/10, sotto l'obiettivo", "Lezione, letto", "Esercizi, adesso": the step, then what it says on screen. */
  function chipLabel(chip: StepChip) {
    const step = t(`plans.path.step.${chip.activity}`);
    const state =
      chip.state === "todo" ||
      chip.state === "missed" ||
      (chip.state === "done" && chip.result)
        ? t(`plans.path.state.${chip.state}`)
        : null;
    return [step, ...chipParts(chip), state].filter(Boolean).join(", ");
  }
  /**
   * A step of a topic: Ripasso mirato prepares its drill; a step already done reopens what was done (the lesson as it was
   * read, the quiz with its score and Redo); the others start.
   */
  function openStep(chip: StepChip, topicId: string) {
    if (chip.activity === "gaps") {
      void drill.start(topicId);
      return;
    }
    const done = steps
      .filter(
        (step) => step.topicId === topicId && step.activity === chip.activity,
      )
      .at(-1);
    // A step shown as to do starts, whatever is on record; one done or scored reopens it, even when it is the suggestion.
    if (done && reopensFinished(chip))
      reopen(done, chip.activity, topicId);
    else go(chip.activity, topicId);
  }
  /** Ripasso mirato on a topic with open gaps: it prepares a drill in place, then opens it. */
  function review(row: TopicRow) {
    if (row.gaps === 0) return null;
    const busy = drill.preparing === row.id;
    return (
      <Button
        variant="secondary"
        size="sm"
        icon={busy ? undefined : "rotate-ccw"}
        disabled={drill.preparing != null}
        aria-label={
          busy
            ? t("examPage.reviewPreparing")
            : t("examPage.reviewTopic", { topic: row.title })
        }
        onClick={() => void drill.start(row.id)}
      >
        {busy ? (
          <span className="px-xpath-working">
            <Logo working decorative size={16} />
            {t("examPage.reviewPreparing")}
          </span>
        ) : (
          t("plans.path.step.gaps")
        )}
      </Button>
    );
  }

  const intro = last("intro");
  const diagnostic = last("diagnostic");
  const showIntro = Boolean(guide?.hasIntro) || intro != null;
  // The diagnostic stays on the path once study has started: it is where the student takes it again or for the first time.
  const showDiagnostic = plan.topics.length > 0;
  const simulationStep = last("simulation");
  const simulation = schedule?.simulation;
  const exam = plan.sessions.find((session) => session.date === plan.examAt);
  const plain = (
    key: string,
    activity: Activity,
    done: Step | undefined,
    title: string,
    detail: string | null,
    icon: IconName,
    extra?: string,
  ) => (
    <li
      key={key}
      className={[
        "px-xpath-row",
        done ? "is-done" : next?.activity === activity ? "is-now" : "is-later",
        extra,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="px-xpath-mk" aria-hidden>
        <Icon name={done ? "check" : icon} size={16} />
      </span>
      <button
        type="button"
        className="px-xpath-head"
        data-focus-key={`path:${activity}`}
        onClick={() => (done ? reopen(done, activity) : go(activity, null))}
      >
        <span className="px-xpath-title">{title}</span>
        {detail ? <span className="px-xpath-sub">{detail}</span> : null}
      </button>
    </li>
  );

  return (
    <section className="px-xpath" aria-labelledby={`${ids}-title`}>
      <h2 className="px-exam-sech" id={`${ids}-title`}>
        {t("examPage.path")}
      </h2>
      {hoursHint ? (
        <Notice
          tone="info"
          action={{
            label: t("plans.path.hoursAction"),
            onClick: () => navigate(`/plans/${planId}/settings`, { state: { focus: "hours" } }),
          }}
        >
          {t("plans.path.hoursHint")}
        </Notice>
      ) : null}
      {drill.stopped != null ? (
        <Notice
          tone="danger"
          action={{
            label: t("components.notice.retry"),
            onClick: drill.retry,
          }}
        >
          {t(drill.readFailed ? "examPage.reviewReadFailed" : "examPage.reviewFailed")}
        </Notice>
      ) : null}
      <ol
        className="px-xpath-list"
        aria-label={t("plans.path.label", { count: rows.length })}
      >
        {showIntro
          ? plain(
              "intro",
              "intro",
              intro,
              name("intro"),
              intro ? t("plans.path.result.intro") : t("plans.path.introSub"),
              activityIcons.intro,
            )
          : null}
        {showDiagnostic
          ? plain(
              "diagnostic",
              "diagnostic",
              diagnostic,
              name("diagnostic"),
              diagnostic?.result
                ? `${points.format(diagnostic.result.correct)}/${diagnostic.result.total}`
                : diagnostic
                  ? t("plans.path.result.done")
                  : t("plans.path.diagnosticSub"),
              activityIcons.diagnostic,
            )
          : null}
        {rows.map((row) => {
          const topic = plan.topics.find((item) => item.id === row.id)!;
          const open = openTopic === row.id;
          const state = row.atGoal
            ? "is-done"
            : row.current
              ? "is-now"
              : "is-later";
          const measured = row.mastery > 0 || row.done > 0;
          const outline = open ? openOutline : null;
          return (
            <li
              key={row.id}
              className={["px-xpath-row", "is-topic", state, open && "is-open"]
                .filter(Boolean)
                .join(" ")}
            >
              <span className="px-xpath-mk" aria-hidden>
                {row.index}
              </span>
              <button
                type="button"
                className="px-xpath-head"
                // What a page opened from the path returns the focus to (history.ts): the step, or its row when closed.
                data-focus-key={`path:${row.id}`}
                aria-expanded={open}
                aria-controls={open ? `${ids}-${row.id}` : undefined}
                onClick={() => setChosen(open ? null : row.id)}
                onPointerEnter={() => prefetchParts(row.id)}
                onFocus={() => prefetchParts(row.id)}
              >
                <span className="px-xpath-title">{row.title}</span>
                <span className="px-xpath-sub">{sub(row, outline)}</span>
              </button>
              <span className="px-xpath-score">
                {measured ? (
                  <>
                    <span className="visually-hidden">
                      {t("plans.path.mastery", { topic: row.title })}:{" "}
                    </span>
                    {grade.mastery(row.mastery)}
                  </>
                ) : null}
              </span>
              {!open && (row.atGoal || row.gaps > 0) ? (
                <div className="px-xpath-steprow">
                  {row.steps
                    .filter((chip) => chip.state === "done")
                    .map((chip) => (
                      <span key={chip.activity}>
                        <Icon name="check" size={14} />
                        {t(`plans.path.step.${chip.activity}`)}
                      </span>
                    ))}
                  {review(row)}
                </div>
              ) : null}
              {open ? (
                <div id={`${ids}-${row.id}`} className="px-xpath-detail">
                  {outline ? (
                    <TopicParts
                      planId={planId}
                      topicId={row.id}
                      topic={row.title}
                      outline={outline}
                      suggested={
                        next?.activity === "lesson" && next.topicId === row.id ? (next.part?.position ?? null) : null
                      }
                    />
                  ) : null}
                  <ul
                    className="px-xpath-substeps"
                    aria-label={t("plans.path.stepsFor", { topic: row.title })}
                  >
                    {/* A lesson in parts lists its parts above, in the lesson step's place; one finished before it was rewritten in parts keeps its step. */}
                    {row.steps
                      .filter(
                        (chip) =>
                          !(outline && chip.activity === "lesson" && !keepsLessonStep(outline, lessonDone(row))),
                      )
                      .map((chip) => (
                      <li key={chip.activity}>
                        <button
                          type="button"
                          className={`px-xpath-substep is-${chip.state}`}
                          data-focus-key={`path:${row.id}:${chip.activity}`}
                          aria-label={chipLabel(chip)}
                          disabled={
                            chip.activity === "gaps" && drill.preparing != null
                          }
                          onClick={() => openStep(chip, row.id)}
                        >
                          {chip.activity === "gaps" &&
                          drill.preparing === row.id ? (
                            <Logo working decorative size={16} />
                          ) : (
                            <Icon name={stepIcons[chip.state]} size={16} />
                          )}
                          {/* The trailing space keeps the step and its note two words in the button's text. */}
                          <span>{`${t(`plans.path.step.${chip.activity}`)} `}</span>
                          <span className="px-xpath-meta">
                            {chip.activity === "gaps" &&
                            drill.preparing === row.id
                              ? t("examPage.reviewPreparing")
                              : chipMeta(chip)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="px-xpath-tools">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="network"
                      onClick={() => onTopicAction("map", topic)}
                    >
                      {t("map.title")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="book-open"
                      disabled={!topic.firstPassageId}
                      onClick={() => onTopicAction("viewer", topic)}
                    >
                      {t("planOverview.openViewer")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="message-circle"
                      onClick={() => onTopicAction("ask", topic)}
                    >
                      {t("planOverview.askTopic")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="plus"
                      onClick={() => onTopicAction("create", topic)}
                    >
                      {t("examPage.create")}
                    </Button>
                  </div>
                  {topic.summary || topic.subtopics.length ? (
                    <p className="px-xpath-about">
                      {topic.summary}
                      {topic.summary && topic.subtopics.length ? " " : null}
                      {topic.subtopics.map((part, index) => (
                        <Fragment key={index}>
                          {index ? " · " : null}
                          <InlineMarkdown>{part}</InlineMarkdown>
                        </Fragment>
                      ))}
                    </p>
                  ) : null}
                  {topic.items.length ? (
                    <p className="px-xpath-items">
                      <span>{t("plans.path.made")}</span>
                      {topic.items.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className="px-xpath-item"
                          data-focus-key={`path:${topic.id}:item:${item.id}`}
                          disabled={itemsBusy}
                          onClick={() => onOpenItem(item, topic.id)}
                        >
                          {t(
                            item.kind === "lesson"
                              ? "lesson.title"
                              : item.kind === "quiz"
                                ? "quiz.title"
                                : item.kind === "map"
                                  ? "map.title"
                                  : `plans.${item.kind}`,
                          )}{" "}
                          ·{" "}
                          {new Date(item.createdAt).toLocaleDateString(
                            i18n.language,
                          )}
                        </button>
                      ))}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
        {plan.topics.length
          ? plain(
              "simulation",
              "simulation",
              simulationStep,
              name("simulation"),
              simulationStep
                ? simulationStep.result
                  ? t("examPage.simulationDone", {
                      result: `${points.format(simulationStep.result.correct)}/${simulationStep.result.total}`,
                    })
                  : t("plans.path.simulationDone")
                : simulation
                  ? when(simulation.date)
                  : t("plans.path.simulationSub"),
              "diamond",
              simulationStep ? "is-mile is-done-mile" : "is-mile",
            )
          : null}
        {plan.examAt != null ? (
          <li className="px-xpath-row is-later is-goal">
            <span className="px-xpath-mk" aria-hidden>
              <Icon name="star" size={16} />
            </span>
            <div className="px-xpath-head">
              <span className="px-xpath-title">
                {exam?.label?.trim() || t("plans.path.exam")}
              </span>
              <span className="px-xpath-sub">
                {new Intl.DateTimeFormat(i18n.language, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                }).format(plan.examAt)}
              </span>
            </div>
          </li>
        ) : null}
      </ol>
    </section>
  );
}

/** A part's state in words, the part page's own; the recap's agree with "Ripasso" in Italian (`plans.path.recapState`). */
const partState = { done: "lesson.partRead", unwritten: "lesson.partUnwritten", writing: "lesson.partWriting" } as const;

const partIcons = {
  done: "check",
  now: "arrow-right",
  todo: "circle",
  unwritten: "circle-dashed",
} as const satisfies Record<string, IconName>;

/**
 * An open topic's lesson in parts, in the lesson step's place: "Lezione in 8 parti e un ripasso", a row per part that
 * opens it (ticked once read, the suggested one with "adesso", dashed until written, the working mark while it is
 * written), and the note on the dashed ones.
 */
function TopicParts({
  planId,
  topicId,
  topic,
  outline,
  suggested,
}: {
  planId: string;
  topicId: string;
  topic: string;
  outline: Outline;
  /** The part the exam page suggests, when its suggestion is this lesson. */
  suggested: number | null;
}) {
  const { t } = useTranslation();
  const unwritten = outline.parts.some((part) => !part.done && (part.state === "unwritten" || part.state === "failed"));
  return (
    <div className="px-xpath-parts">
      <p className="px-xpath-parts-head">{partsHeading(t, outline)}</p>
      <ul className="px-xpath-substeps" aria-label={t("plans.path.lessonPartsFor", { topic })}>
        {outline.parts.map((part) => {
          const mark = part.done
            ? "done"
            : part.position === suggested
              ? "now"
              : part.state === "writing"
                ? "writing"
                : part.state === "written"
                  ? "todo"
                  : "unwritten";
          const recap = part.kind === "recap";
          // The state the row draws with its mark, said in words; "adesso" is in its text already.
          const state =
            mark === "done" || mark === "unwritten" || mark === "writing"
              ? recap
                ? t(`plans.path.recapState.${mark}`)
                : t(partState[mark])
              : null;
          return (
            <li key={part.id}>
              <Link
                className={`px-xpath-substep is-${mark}`}
                data-focus-key={`path:${topicId}:part:${part.position}`}
                to={partPath(planId, topicId, part.position)}
              >
                {mark === "writing" ? <Logo working decorative size={16} /> : <Icon name={partIcons[mark]} size={16} />}
                <span>
                  {recap ? (
                    t("lesson.recapTitle")
                  ) : (
                    <MathText text={`${t("plans.path.partNumber", { n: part.position })} · ${part.title}`} />
                  )}
                </span>
                {/* The link's name: "Parte 1 · Intorni, letta, 5 min". */}
                <span className="visually-hidden">{state ? `, ${state}, ` : ", "}</span>
                <span className="px-xpath-meta">
                  {t(mark === "now" ? "plans.path.partNow" : "lesson.minutesShort", { count: part.minutes })}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {unwritten ? <p className="px-xpath-parts-note">{t("lesson.partsNote")}</p> : null}
    </div>
  );
}
