import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { CalendarRange, Check, ChevronRight } from "lucide-react";
import type { RequestOutput } from "@shared/ipc";
import { Icon } from "../../components/Icon";
import { Notice } from "../../components/Notice";
import { Tag } from "../../components/Tag";
import { invoke } from "../../lib/ipc";
import { useGradeScale } from "../../lib/useGradeScale";
import { activityIcons } from "../plans/PlanPath";
import { examDaysLabel } from "../plans/examDays";
import { stepPath } from "../plans/reopen";
import { behindText, formatMinutes } from "./plannerFormat";
import "./OggiBlock.css";

type Today = RequestOutput<"plans.today">;
type Item = Today["items"][number];

/**
 * Oggi: today's study across every exam, at the top of the exam list. Due flashcards from all plans are one item, then
 * each plan's next step on the path, the closest exam first. The first item not done is the suggested one; done items
 * stay in place, ticked, until tomorrow.
 */
export function OggiBlock() {
  const { t } = useTranslation();
  const grade = useGradeScale();
  const navigate = useNavigate();
  const heading = useId();
  const today = useQuery({
    queryKey: ["plans", "today"],
    queryFn: () => invoke("plans.today", {}),
  });
  if (today.isPending) return null;
  if (today.isError)
    return (
      <section className="px-oggi" aria-labelledby={heading}>
        <h2 className="title-2" id={heading}>
          {t("oggi.title")}
        </h2>
        <Notice tone="danger">{t("oggi.failed")}</Notice>
      </section>
    );
  const { cards, items, behind } = today.data;
  const cardsDone = cards != null && cards.due === 0;
  const firstOpen =
    cards && !cardsDone ? "cards" : (items.find((item) => !item.complete)?.planId ?? null);
  const empty = !cards && items.length === 0;
  const allDone = !empty && firstOpen === null;
  const name = (activity: Item["done"][number]["activity"]) =>
    t(`plans.path.activity.${activity}`);
  const stepLabel = (step: { activity: Item["done"][number]["activity"]; topicTitle: string | null }) =>
    step.topicTitle
      ? t("plans.path.on", { activity: name(step.activity), topic: step.topicTitle })
      : name(step.activity);

  function open(item: Item) {
    const to = item.next
      ? stepPath(item.planId, item.next.activity, item.next.topicId)
      : null;
    navigate(to ?? `/plans/${item.planId}`);
  }

  return (
    <section className="px-oggi" aria-labelledby={heading}>
      <div className="px-oggi-head">
        <h2 className="title-2" id={heading}>
          {t("oggi.title")}
        </h2>
        <Link to="/exams/planner" className="px-oggi-planner">
          <CalendarRange size={16} strokeWidth={1.75} aria-hidden />
          {t("planner.title")}
        </Link>
      </div>
      {behind.length > 0 ? (
        <Notice
          tone="warning"
          action={{ label: t("oggi.seePlanner"), onClick: () => navigate("/exams/planner") }}
        >
          {behindText(t, behind[0]!, grade.format, grade.mastery)}
          {behind.length > 1 ? ` ${t("oggi.moreBehind", { count: behind.length - 1 })}` : ""}
        </Notice>
      ) : null}
      {empty ? (
        <p className="body ink-muted">{t("oggi.empty")}</p>
      ) : (
        <ol className="px-oggi-list">
          {cards ? (
            <li>
              <OggiRow
                icon="layers"
                done={cardsDone}
                suggested={firstOpen === "cards"}
                title={t(cardsDone ? "oggi.cardsDone" : "oggi.cards")}
                meta={
                  cardsDone
                    ? t("oggi.cardsRated", { count: cards.ratedToday })
                    : [
                        t("oggi.cardsDue", { count: cards.due }),
                        cards.plans > 1 ? t("oggi.cardsFrom", { count: cards.plans }) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                }
                onClick={() => navigate("/cards/due")}
              />
            </li>
          ) : null}
          {items.map((item) => {
            const lastDone = item.done.at(-1);
            const shown = item.complete && lastDone ? lastDone : item.next;
            const exam =
              item.daysToExam == null ? t("oggi.noDate") : examDaysLabel(t, item.daysToExam);
            const extra = item.complete
              ? t("oggi.doneToday")
              : item.minutesLeft
                ? t("oggi.minutesLeft", { time: formatMinutes(t, item.minutesLeft) })
                : null;
            return (
              <li key={item.planId}>
                <OggiRow
                  icon={shown ? activityIcons[shown.activity] : "graduation-cap"}
                  done={item.complete}
                  suggested={firstOpen === item.planId}
                  title={shown ? stepLabel(shown) : item.title}
                  meta={[item.title, exam, extra].filter(Boolean).join(" · ")}
                  onClick={() => open(item)}
                />
              </li>
            );
          })}
        </ol>
      )}
      {allDone ? <p className="small ink-muted">{t("oggi.allDone")}</p> : null}
    </section>
  );
}

function OggiRow(props: {
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  meta: string;
  done: boolean;
  suggested: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={["px-oggi-item", props.done ? "is-done" : "", props.suggested ? "is-next" : ""]
        .filter(Boolean)
        .join(" ")}
      onClick={props.onClick}
    >
      <span className="px-oggi-icon">
        {props.done ? (
          <Check size={18} strokeWidth={2} aria-hidden />
        ) : (
          <Icon name={props.icon} size={18} />
        )}
      </span>
      <span className="px-oggi-text">
        <span className="body-strong">{props.title}</span>
        <span className="small ink-muted">{props.meta}</span>
      </span>
      {props.suggested ? <Tag tone="recommended">{t("plans.path.suggested")}</Tag> : null}
      {props.done ? <span className="px-oggi-done small">{t("oggi.done")}</span> : null}
      <ChevronRight className="px-oggi-chevron" size={16} strokeWidth={1.75} aria-hidden />
    </button>
  );
}
