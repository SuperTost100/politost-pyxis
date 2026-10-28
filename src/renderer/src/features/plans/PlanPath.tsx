import { useId, useMemo, useRef, useState } from "react";
import { Button, Dropdown, Input } from "antd";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { Icon, type IconName } from "../../components/Icon";
import { MasteryBar } from "../../components/MasteryBar";
import { Tag } from "../../components/Tag";
import { useGradeScale } from "../../lib/useGradeScale";
import { searchMatcher } from "../../lib/search";
import { topicRows, type StepChip, type TopicRow } from "./pathRows";
import { reopenPath, skipDiagnosticPath, stepPath } from "./reopen";
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
const topicOptions = ["lesson", "practice", "quiz", "cards", "gaps"] as const;
const planOptions = ["simulation", "diagnostic", "intro"] as const;
const stepIcons: Record<StepChip["state"], IconName> = {
  done: "check",
  missed: "circle-x",
  todo: "circle",
  now: "target",
};

/** "lun 9 nov" from a YYYY-MM-DD day, read as a local date. */
function shortDay(day: string, language: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Intl.DateTimeFormat(language, { weekday: "short", day: "numeric", month: "short" }).format(
    new Date(year!, month! - 1, date!),
  );
}

/**
 * The "Now" card: the path's one suggested step with the page's only primary button, and every other activity one
 * click away. Nothing is locked.
 */
export function NextStep({
  planId,
  plan,
  guide,
}: {
  planId: string;
  plan: Plan;
  guide: Guide | undefined;
}) {
  const { t } = useTranslation();
  const grade = useGradeScale();
  const navigate = useNavigate();
  const ids = useId();
  const card = useRef<HTMLElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const firstOption = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");

  const next = guide?.next ?? null;
  const topics = plan.topics;
  const status = new Map(guide?.topics.map((topic) => [topic.topicId, topic]));
  const title = (topicId: string | null) => topics.find((topic) => topic.id === topicId)?.title ?? "";
  const name = (activity: Activity) => t(`plans.path.activity.${activity}`);
  const read = new Set(
    plan.steps.filter((step) => step.activity === "lesson").map((step) => step.topicId),
  );
  const defaultTopic =
    next?.topicId ?? topics.find((topic) => !read.has(topic.id))?.id ?? topics[0]?.id ?? null;
  const topicId = picked && topics.some((topic) => topic.id === picked) ? picked : defaultTopic;
  const topic = topicId ? status.get(topicId) : undefined;
  // One "Suggested" mark: the path's pick, or what fits a topic the student chose instead.
  const marked: Activity | null =
    picked && picked !== next?.topicId ? (topic?.suggested ?? null) : (next?.activity ?? null);
  const skipTo = skipDiagnosticPath(planId, topics, plan.steps);
  const matches = useMemo(() => {
    const titleMatches = searchMatcher(query);
    return query.trim() ? topics.filter((item) => titleMatches(item.title)) : topics;
  }, [query, topics]);

  function go(activity: Activity, topic: string | null) {
    const to = stepPath(planId, activity, topic);
    if (to) navigate(to);
  }
  function closePicker() {
    setPicking(false);
    setQuery("");
    requestAnimationFrame(() => changeButton.current?.focus());
  }

  const option = (activity: Activity, topic: string | null, index: number) => {
    const meta =
      activity === "lesson" && topic && read.has(topic)
        ? t("plans.path.result.lesson")
        : activity === "cards" && topic && (status.get(topic)?.dueCards ?? 0) > 0
          ? t("plans.path.due", { count: status.get(topic)!.dueCards })
          : activity === "gaps" && topic
            ? t("plans.path.gaps", { count: status.get(topic)?.gaps ?? 0 })
            : activity === "intro" && plan.steps.some((step) => step.activity === "intro")
              ? t("plans.path.result.intro")
              : null;
    return (
      <li key={activity}>
        <button
          type="button"
          className="px-path-option"
          ref={index === 0 ? firstOption : undefined}
          onClick={() => go(activity, topic)}
        >
          <span className="px-path-option-icon">
            <Icon name={activityIcons[activity]} size={18} />
          </span>
          <span className="px-path-option-text">
            <span className="body-strong">{name(activity)}</span>
            {meta ? <span className="meta ink-muted">{meta}</span> : null}
            {marked === activity ? <Tag tone="recommended">{t("plans.path.suggested")}</Tag> : null}
          </span>
        </button>
      </li>
    );
  };
  const gap = next?.reason === "gaps";

  return (
    <section ref={card} className="px-path-next" aria-labelledby={`${ids}-next`}>
      <span className={gap ? "px-path-next-icon is-gap" : "px-path-next-icon"}>
        <Icon name={next ? activityIcons[next.activity] : "compass"} size={24} />
      </span>
      <div className="px-path-next-copy">
        <p className="label px-path-eyebrow">{t("plans.path.next")}</p>
        <h2 id={`${ids}-next`} className="title-3">
          {next
            ? next.topicId
              ? t("plans.path.on", { activity: name(next.activity), topic: title(next.topicId) })
              : name(next.activity)
            : t("plans.path.pick")}
        </h2>
        {next ? (
          <p className="small ink-muted">{t(`plans.path.reason.${next.reason}`, { count: next.count })}</p>
        ) : null}
      </div>
      <div className="px-path-next-actions">
        {next ? (
          <Button type="primary" onClick={() => go(next.activity, next.topicId)}>
            {t("planOverview.start")}
          </Button>
        ) : null}
        {next?.activity === "diagnostic" && skipTo ? (
          <Button onClick={() => navigate(skipTo)}>{t("plans.path.skipDiagnostic")}</Button>
        ) : null}
        <Button
          type="text"
          ref={moreButton}
          aria-expanded={open}
          aria-controls={`${ids}-chooser`}
          onClick={() => {
            setOpen(!open);
            setPicking(false);
          }}
        >
          <span className="px-path-more">
            {t("plans.path.more")}
            <ChevronDown size={16} strokeWidth={1.75} aria-hidden className={open ? "is-open" : ""} />
          </span>
        </Button>
      </div>
      {open ? (
        <div
          id={`${ids}-chooser`}
          className="px-path-chooser"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || picking) return;
            event.stopPropagation();
            setOpen(false);
            moreButton.current?.focus();
          }}
        >
          {topic && topicId ? (
            <div className="px-path-topic">
              <div className="px-path-topic-copy">
                <p className="label ink-muted">{t("planOverview.topic")}</p>
                <p className="body-strong">{title(topicId)}</p>
              </div>
              <div className="px-path-topic-mastery">
                <MasteryBar
                  value={topic.mastery * 100}
                  target={plan.target * 100}
                  scale={grade.scale}
                  label={t("plans.path.mastery", { topic: title(topicId) })}
                />
              </div>
              <Button
                ref={changeButton}
                size="small"
                aria-expanded={picking}
                aria-controls={`${ids}-topics`}
                onClick={() => (picking ? closePicker() : setPicking(true))}
              >
                {t("plans.path.change")}
              </Button>
            </div>
          ) : null}
          {picking ? (
            <div
              id={`${ids}-topics`}
              className="px-path-picker"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                closePicker();
              }}
            >
              <Input
                autoFocus
                allowClear
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("plans.path.search")}
                aria-label={t("plans.path.search")}
                prefix={<Icon name="search" size={16} />}
              />
              {matches.length ? (
                <ul className="px-path-picker-list" aria-label={t("plans.path.topics")}>
                  {matches.map((item) => {
                    const mastery = grade.format(status.get(item.id)?.mastery ?? 0);
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          aria-current={item.id === topicId ? "true" : undefined}
                          aria-label={`${item.title}, ${mastery}${read.has(item.id) ? `, ${t("plans.path.result.lesson")}` : ""}`}
                          onClick={() => {
                            setPicked(item.id);
                            closePicker();
                          }}
                        >
                          <span className="px-path-picker-title">{item.title}</span>
                          {read.has(item.id) ? (
                            <span className="meta ink-muted">{t("plans.path.result.lesson")}</span>
                          ) : null}
                          <span className="px-path-picker-value meta">{mastery}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="small ink-muted">{t("plans.path.noMatch")}</p>
              )}
            </div>
          ) : (
            <>
              {topicId ? (
                <ul className="px-path-options" aria-label={t("plans.path.forTopic", { topic: title(topicId) })}>
                  {topicOptions
                    .filter((activity) => activity !== "gaps" || (topic?.gaps ?? 0) > 0)
                    .map((activity, index) => option(activity, topicId, index))}
                </ul>
              ) : null}
              <p className="label ink-muted px-path-whole">{t("plans.path.whole")}</p>
              <ul className="px-path-options" aria-label={t("plans.path.whole")}>
                {planOptions
                  .filter((activity) => activity !== "intro" || guide?.hasIntro)
                  .map((activity, index) => option(activity, null, topicId ? -1 : index))}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The exam's path as one column of rows: what was done, folded into one row; the introduction and the starting test
 * while they are still to do; every topic in the plan's order with its mastery against the goal and the day the
 * planner expects it done; then the simulation and the exam day. The topic the student is on opens and shows its
 * steps; any other opens on a click. Nothing is locked.
 */
export function PlanPath({
  planId,
  plan,
  guide,
  schedule,
  onTopicAction,
  onOpenItem,
  itemsBusy,
}: {
  planId: string;
  plan: Plan;
  guide: Guide | undefined;
  schedule: Schedule | undefined;
  onTopicAction: (action: TopicAction, topic: Topic) => void;
  onOpenItem: (item: Topic["items"][number], topicId: string) => void;
  itemsBusy: boolean;
}) {
  const { t, i18n } = useTranslation();
  const grade = useGradeScale();
  const navigate = useNavigate();
  const ids = useId();
  const [showDone, setShowDone] = useState(false);
  const next = guide?.next ?? null;
  const rows = topicRows({
    topics: plan.topics,
    steps: plan.steps,
    status: guide?.topics ?? [],
    next,
    goal: plan.target,
    schedule: schedule?.topics ?? null,
  });
  // The topic the path is on starts open; a click opens another one instead, and a second click closes it.
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const openTopic = chosen === undefined ? (rows.find((row) => row.current)?.id ?? null) : chosen;
  const steps = plan.steps;
  const did = (activity: Activity) => steps.some((step) => step.activity === activity);
  const studied = steps.some((step) => step.activity !== "intro" && step.activity !== "diagnostic");
  const showIntro = Boolean(guide?.hasIntro) && !did("intro");
  const showDiagnostic = plan.topics.length > 0 && !did("diagnostic") && !studied;
  const name = (activity: Activity) => t(`plans.path.activity.${activity}`);
  const title = (topicId: string | null) => plan.topics.find((topic) => topic.id === topicId)?.title ?? "";
  const day = (value: string) => shortDay(value, i18n.language);

  function go(activity: Activity, topic: string | null) {
    const to = stepPath(planId, activity, topic);
    if (to) navigate(to);
  }
  function result(step: Step) {
    if (step.activity === "lesson" || step.activity === "intro") return t(`plans.path.result.${step.activity}`);
    if (!step.result) return t("plans.path.result.done");
    if (step.activity === "cards") return t("plans.path.result.cards", { count: step.result.total });
    return `${step.result.correct}/${step.result.total}`;
  }
  function when(date: string | null | undefined) {
    if (date === undefined) return null;
    return date === null ? t("plans.path.late") : t("plans.path.expected", { date: day(date) });
  }
  function sub(row: TopicRow) {
    if (row.atGoal)
      return (
        <>
          <Tag tone="mastered">{t("plans.path.atGoal")}</Tag>
          <span>{t("plans.path.activities", { count: row.done })}</span>
        </>
      );
    const parts = [
      row.last
        ? t("progress.lastStudied", {
            date: new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short" }).format(row.last.at),
          })
        : null,
      when(row.date),
    ].filter((part): part is string => Boolean(part));
    return (
      <>
        {row.gaps > 0 ? <Tag tone="severe" icon="circle-alert">{t("plans.path.gaps", { count: row.gaps })}</Tag> : null}
        {parts.map((part) => (
          <span key={part}>{part}</span>
        ))}
        {!parts.length && !row.gaps && row.mastery === 0 ? <span>{t("progress.neverStudied")}</span> : null}
      </>
    );
  }
  function chipText(chip: StepChip) {
    const step = t(`plans.path.step.${chip.activity}`);
    if (chip.state === "now") return t("plans.path.stepNow", { step });
    if (chip.result) return t("plans.path.stepScore", { step, correct: chip.result.correct, total: chip.result.total });
    if (chip.activity === "cards") return `${step}, ${t("plans.path.due", { count: chip.count ?? 0 })}`;
    if (chip.activity === "gaps") return `${step}, ${t("plans.path.gaps", { count: chip.count ?? 0 })}`;
    return step;
  }

  const simulation = schedule?.simulation;
  return (
    <div className="px-path">
      <ol className="px-path-rows" aria-label={t("plans.path.label", { count: rows.length })}>
        {steps.length ? (
          <li className="px-path-row is-done-line">
            <span className="px-path-node is-done" aria-hidden>
              <Icon name="check" size={16} />
            </span>
            <button
              type="button"
              className="px-path-summary"
              aria-expanded={showDone}
              aria-controls={showDone ? `${ids}-done` : undefined}
              onClick={() => setShowDone(!showDone)}
            >
              <span className="body-strong">{t("plans.path.doneCount", { count: steps.length })}</span>{" "}
              <span aria-hidden>·</span>{" "}
              <span className="px-path-summary-toggle">{t(showDone ? "plans.path.hide" : "plans.path.show")}</span>
            </button>
            {showDone ? (
              <ol id={`${ids}-done`} className="px-path-done" aria-label={t("plans.path.done")}>
                {steps.map((step) => {
                  const detail = step.topicId ? title(step.topicId) : null;
                  const meta = result(step);
                  return (
                    <li key={step.id}>
                      {/* The name comes from the text, read as "Quiz, Forces, 6/10 (done)". */}
                      <button
                        type="button"
                        onClick={() => {
                          const to = reopenPath(planId, step);
                          if (to) navigate(to);
                        }}
                      >
                        <Icon name={activityIcons[step.activity]} size={16} />
                        {/* Each part is a grid item, read with a space after it; the separators are for the name only. */}
                        <span className="px-path-done-name">
                          {name(step.activity)}
                          <span className="px-path-sep">,</span>
                        </span>
                        <span className="ink-muted px-path-done-detail">
                          {detail ? (
                            <>
                              {detail}
                              <span className="px-path-sep">,</span>
                            </>
                          ) : null}
                        </span>
                        <span className="meta px-path-done-meta">
                          {meta}
                          <span className="px-path-sep"> ({t("components.path.state.done")})</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </li>
        ) : null}
        {showIntro ? (
          <li className={next?.activity === "intro" ? "px-path-row is-current" : "px-path-row"}>
            <span className="px-path-node is-step" aria-hidden>
              <Icon name={activityIcons.intro} size={16} />
            </span>
            <button type="button" className="px-path-row-main" onClick={() => go("intro", null)}>
              <span className="px-path-name">{name("intro")}</span>
              <span className="px-path-sub small ink-muted">{t("plans.path.introSub")}</span>
            </button>
            <Icon name="chevron-right" size={18} className="px-path-chev" />
          </li>
        ) : null}
        {showDiagnostic ? (
          <li className={next?.activity === "diagnostic" ? "px-path-row is-current" : "px-path-row"}>
            <span className="px-path-node is-step" aria-hidden>
              <Icon name={activityIcons.diagnostic} size={16} />
            </span>
            <button type="button" className="px-path-row-main" onClick={() => go("diagnostic", null)}>
              <span className="px-path-name">{name("diagnostic")}</span>
              <span className="px-path-sub small ink-muted">{t("plans.path.diagnosticSub")}</span>
            </button>
            <Icon name="chevron-right" size={18} className="px-path-chev" />
          </li>
        ) : null}
        {rows.length ? (
          <li className="px-path-group">
            <h2 className="label ink-muted">{t("plans.path.topicsHeading", { count: rows.length })}</h2>
          </li>
        ) : null}
        {rows.map((row) => {
          const topic = plan.topics.find((item) => item.id === row.id)!;
          const open = openTopic === row.id;
          const state = row.atGoal ? "is-done" : row.gaps > 0 ? "is-gap" : row.current ? "is-now" : "";
          return (
            <li
              key={row.id}
              className={["px-path-row", "is-topic", open && "is-open", row.atGoal && "is-done-line"]
                .filter(Boolean)
                .join(" ")}
            >
              <span className={`px-path-node ${state}`} aria-hidden>
                {row.atGoal ? <Icon name="check" size={16} /> : row.index}
              </span>
              <button
                type="button"
                className="px-path-row-main"
                aria-expanded={open}
                aria-controls={open ? `${ids}-${row.id}` : undefined}
                onClick={() => setChosen(open ? null : row.id)}
              >
                <span className="px-path-name">{row.title}</span>
                <span className="px-path-sub small ink-muted">{sub(row)}</span>
              </button>
              <div className="px-path-meter">
                <MasteryBar
                  value={row.mastery * 100}
                  target={plan.target * 100}
                  scale={grade.scale}
                  label={t("plans.path.mastery", { topic: row.title })}
                />
              </div>
              <ChevronDown
                size={18}
                strokeWidth={1.75}
                aria-hidden
                className={open ? "px-path-chev is-open" : "px-path-chev"}
              />
              {open ? (
                <div id={`${ids}-${row.id}`} className="px-path-detail">
                  <div className="px-path-steps">
                    <ul aria-label={t("plans.path.stepsFor", { topic: row.title })}>
                      {row.steps.map((chip) => (
                        <li key={chip.activity}>
                          <button
                            type="button"
                            className={`px-path-step is-${chip.state}`}
                            // The suggested step already says "now" on screen; the others add their state.
                            aria-label={
                              chip.state === "now"
                                ? chipText(chip)
                                : `${chipText(chip)}, ${t(`plans.path.state.${chip.state}`)}`
                            }
                            onClick={() => go(chip.activity, row.id)}
                          >
                            <Icon name={stepIcons[chip.state]} size={16} />
                            {chipText(chip)}
                          </button>
                        </li>
                      ))}
                    </ul>
                    <Dropdown
                      trigger={["click"]}
                      menu={{
                        items: [
                          { key: "map", label: t("map.title") },
                          { key: "viewer", label: t("planOverview.openViewer"), disabled: !topic.firstPassageId },
                          { key: "ask", label: t("planOverview.askTopic") },
                          { key: "create", label: t("planOverview.create") },
                        ],
                        onClick: ({ key }) => onTopicAction(key as TopicAction, topic),
                      }}
                    >
                      <Button
                        type="text"
                        shape="circle"
                        size="small"
                        aria-label={t("planOverview.topicActions", { title: row.title })}
                        title={t("planOverview.topicActions", { title: row.title })}
                        icon={<Icon name="settings" size={16} />}
                      />
                    </Dropdown>
                  </div>
                  {topic.summary || topic.subtopics.length ? (
                    <p className="small ink-muted px-path-about">
                      {[topic.summary, topic.subtopics.join(" · ")].filter(Boolean).join(" ")}
                    </p>
                  ) : null}
                  {topic.items.length ? (
                    <div className="px-path-items">
                      <span className="small ink-muted">{t("plans.path.made")}</span>
                      {topic.items.map((item) => (
                        <Button
                          key={item.id}
                          size="small"
                          type="link"
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
                          · {new Date(item.createdAt).toLocaleDateString(i18n.language)}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
        {plan.topics.length ? (
          <>
            <li className="px-path-group">
              <h2 className="label ink-muted">{t("plans.path.beforeExam")}</h2>
            </li>
            <li className={next?.activity === "simulation" ? "px-path-row is-current" : "px-path-row"}>
              <span className="px-path-node is-step" aria-hidden>
                <Icon name="file-pen" size={16} />
              </span>
              <button type="button" className="px-path-row-main" onClick={() => go("simulation", null)}>
                <span className="px-path-name">{name("simulation")}</span>
                <span className="px-path-sub small ink-muted">
                  {simulation
                    ? when(simulation.date)
                    : did("simulation")
                      ? t("plans.path.simulationDone")
                      : t("plans.path.simulationSub")}
                </span>
              </button>
              <Icon name="chevron-right" size={18} className="px-path-chev" />
            </li>
          </>
        ) : null}
        {plan.examAt != null ? (
          <li className="px-path-row is-exam">
            <span className="px-path-node is-goal" aria-hidden>
              <Icon name="flag" size={16} />
            </span>
            <div className="px-path-row-main">
              <span className="px-path-name">{t("plans.path.exam")}</span>
              <span className="px-path-sub small ink-muted">
                {new Intl.DateTimeFormat(i18n.language, { weekday: "short", day: "numeric", month: "long" }).format(
                  plan.examAt,
                )}
              </span>
            </div>
          </li>
        ) : null}
      </ol>
    </div>
  );
}
