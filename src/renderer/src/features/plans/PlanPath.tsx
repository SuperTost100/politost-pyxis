import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Input } from "antd";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { Icon, type IconName } from "../../components/Icon";
import { MasteryBar } from "../../components/MasteryBar";
import { PathNode } from "../../components/PathNode";
import { Tag } from "../../components/Tag";
import "./PlanPath.css";

type Plan = NonNullable<RequestOutput<"plans.read">>;
type Guide = NonNullable<RequestOutput<"plans.recommend">>;
type Step = Plan["steps"][number];
type Activity = Step["activity"];

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
/** Done steps shown before "Show all"; a long history would push the next step far down. */
const recent = 8;
/** Space left between a connector line and any box or label it joins. */
const gap = 6;

/**
 * The plan's path: what the student did, one suggested next step with every other activity next to it, and the
 * topics still to come in the plan's order. Nothing is locked.
 */
export function PlanPath({
  planId,
  plan,
  guide,
}: {
  planId: string;
  plan: Plan;
  guide: Guide | undefined;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const ids = useId();
  const frame = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const firstOption = useRef<HTMLButtonElement>(null);
  const scrolled = useRef("");
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [lines, setLines] = useState<Array<{ d: string; tone: "done" | "planned" }>>([]);

  const next = guide?.next ?? null;
  const topics = plan.topics;
  const status = new Map(guide?.topics.map((topic) => [topic.topicId, topic]));
  const title = (topicId: string | null) =>
    topics.find((topic) => topic.id === topicId)?.title ?? "";
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
  const steps = showAll ? plan.steps : plan.steps.slice(-recent);
  const hidden = plan.steps.length - steps.length;
  const planned = topics.filter(
    (item) => !read.has(item.id) && !(next?.activity === "lesson" && next.topicId === item.id),
  );
  const simulationPlanned = next?.activity !== "simulation" && topics.length > 0;
  const matches = useMemo(() => {
    const words = query.trim().toLocaleLowerCase();
    return words
      ? topics.filter((item) => item.title.toLocaleLowerCase().includes(words))
      : topics;
  }, [query, topics]);

  function go(activity: Activity, topic: string | null) {
    if (activity === "intro") navigate(`/plans/${planId}/intro`);
    else if (activity === "diagnostic" || activity === "simulation")
      navigate(`/plans/${planId}/${activity}`);
    else if (!topic) return;
    else if (activity === "gaps")
      navigate(`/plans/${planId}/progress?drill=${encodeURIComponent(topic)}`);
    else navigate(`/plans/${planId}/${activity}/${topic}`);
  }
  /** Opens the chooser on one topic, from a done or a planned box. */
  function choose(topic: string | null) {
    if (topic) setPicked(topic);
    setPicking(false);
    setOpen(true);
    requestAnimationFrame(() => {
      card.current?.scrollIntoView({ block: "nearest" });
      firstOption.current?.focus({ preventScroll: true });
    });
  }
  function closePicker() {
    setPicking(false);
    setQuery("");
    requestAnimationFrame(() => changeButton.current?.focus());
  }
  function result(step: Step) {
    if (step.activity === "lesson" || step.activity === "intro")
      return t(`plans.path.result.${step.activity}`);
    if (!step.result) return t("plans.path.result.done");
    if (step.activity === "cards")
      return t("plans.path.result.cards", { count: step.result.total });
    return `${step.result.correct}/${step.result.total}`;
  }

  useEffect(() => {
    if (!guide || scrolled.current === planId) return;
    scrolled.current = planId;
    const frameId = requestAnimationFrame(() =>
      card.current?.scrollIntoView({ block: "center", behavior: "instant" }),
    );
    return () => cancelAnimationFrame(frameId);
  }, [planId, guide]);

  // Lines join each box to the next one through the space between them, stopping short of every box and label.
  useLayoutEffect(() => {
    const root = frame.current;
    if (!root) return;
    const measure = () => {
      const origin = root.getBoundingClientRect();
      const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-path-node]")).map(
        (node) => {
          const box = (node.querySelector<HTMLElement>("[data-path-box]") ?? node).getBoundingClientRect();
          const whole = node.getBoundingClientRect();
          return {
            x: box.left - origin.left + box.width / 2,
            top: box.top - origin.top,
            bottom: whole.bottom - origin.top,
            planned: node.dataset.pathNode === "planned",
          };
        },
      );
      setLines(
        nodes.slice(1).flatMap((node, index) => {
          const from = nodes[index]!;
          const start = from.bottom + gap;
          const end = node.top - gap;
          if (end - start < 4) return [];
          const middle = (start + end) / 2;
          return [
            {
              d: `M${from.x} ${start} C${from.x} ${middle} ${node.x} ${middle} ${node.x} ${end}`,
              tone: node.planned ? ("planned" as const) : ("done" as const),
            },
          ];
        }),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    measure();
    return () => observer.disconnect();
  }, [plan, guide, open, picking, showAll, matches]);

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
            {marked === activity ? (
              <Tag tone="recommended">{t("plans.path.suggested")}</Tag>
            ) : null}
          </span>
        </button>
      </li>
    );
  };

  return (
    <div className="px-path" ref={frame}>
      {hidden > 0 ? (
        <Button type="text" className="px-path-all" onClick={() => setShowAll(true)}>
          {t("plans.path.showAll", { count: plan.steps.length })}
        </Button>
      ) : null}
      {steps.length ? (
        <ol className="px-path-list" aria-label={t("plans.path.done")}>
          {steps.map((step, index) => (
            <li
              key={step.id}
              className={`px-path-item ${(steps.length - index) % 2 ? "is-left" : "is-right"}`}
              data-path-node="done"
            >
              <PathNode
                icon={activityIcons[step.activity]}
                state="done"
                label={name(step.activity)}
                detail={step.topicId ? title(step.topicId) : undefined}
                meta={result(step)}
                onClick={() => choose(step.topicId)}
              />
            </li>
          ))}
        </ol>
      ) : null}
      <section
        ref={card}
        className="px-path-next"
        aria-labelledby={`${ids}-next`}
        data-path-node="next"
      >
        <div className="px-path-next-head">
          <span className="px-path-next-icon">
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
              <p className="small ink-muted">
                {t(`plans.path.reason.${next.reason}`, { count: next.count })}
              </p>
            ) : null}
          </div>
        </div>
        <div className="px-path-next-actions">
          {next ? (
            <Button type="primary" onClick={() => go(next.activity, next.topicId)}>
              {t("planOverview.start")}
            </Button>
          ) : null}
          <Button
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
                    value={Math.round(topic.mastery * 100)}
                    target={plan.target * 100}
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
                      const mastery = Math.round((status.get(item.id)?.mastery ?? 0) * 100);
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            aria-current={item.id === topicId ? "true" : undefined}
                            aria-label={`${item.title}, ${mastery}%${read.has(item.id) ? `, ${t("plans.path.result.lesson")}` : ""}`}
                            onClick={() => {
                              setPicked(item.id);
                              closePicker();
                            }}
                          >
                            <span className="px-path-picker-title">{item.title}</span>
                            {read.has(item.id) ? (
                              <span className="meta ink-muted">{t("plans.path.result.lesson")}</span>
                            ) : null}
                            <span className="px-path-picker-value meta">{mastery}%</span>
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
                  <ul
                    className="px-path-options"
                    aria-label={t("plans.path.forTopic", { topic: title(topicId) })}
                  >
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
      {planned.length || simulationPlanned ? (
        <>
          <h2 className="label px-path-heading">{t("plans.path.planned")}</h2>
          <ol className="px-path-list" aria-label={t("plans.path.planned")}>
            {planned.map((item, index) => (
              <li
                key={item.id}
                className={`px-path-item ${index % 2 ? "is-left" : "is-right"}`}
                data-path-node="planned"
              >
                <PathNode
                  icon="book-open"
                  state="planned"
                  label={item.title}
                  ariaLabel={t("plans.path.choose", { topic: item.title })}
                  onClick={() => choose(item.id)}
                />
              </li>
            ))}
            {simulationPlanned ? (
              <li
                className={`px-path-item ${planned.length % 2 ? "is-left" : "is-right"}`}
                data-path-node="planned"
              >
                <PathNode
                  icon={activityIcons.simulation}
                  state="planned"
                  label={name("simulation")}
                  ariaLabel={t("plans.path.choose", { topic: name("simulation") })}
                  onClick={() => choose(null)}
                />
              </li>
            ) : null}
          </ol>
        </>
      ) : null}
      <svg className="px-path-lines" aria-hidden>
        {lines.map((line, index) => (
          <path key={index} d={line.d} className={`is-${line.tone}`} />
        ))}
      </svg>
    </div>
  );
}
