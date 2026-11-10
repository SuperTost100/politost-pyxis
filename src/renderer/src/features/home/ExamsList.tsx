import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { Button } from "../../components/Button";
import { ExamRings, useRingText } from "../../components/ExamRings";
import { Icon } from "../../components/Icon";
import { LoadError } from "../../components/LoadError";
import { Logo } from "../../components/Logo";
import { Notice } from "../../components/Notice";
import { Reveal } from "../../components/Controls";
import { errorDetails } from "../../lib/errorDetails";
import { plansQuery, ringsQuery } from "../../lib/queries";
import { useGradeScale } from "../../lib/useGradeScale";
import "./ExamsList.css";

type Plan = RequestOutput<"plans.list">[number];
type Ring = RequestOutput<"plans.rings">[number];

/** "Scritto venerdì 22 gennaio", "Esame oggi", "Data da scegliere": when the exam is, in one line. */
export function useExamWhen() {
  const { t, i18n } = useTranslation();
  return (plan: Pick<Plan, "examAt" | "examLabel" | "daysToExam">) => {
    if (plan.examAt == null || plan.daysToExam == null) return t("exams.noDate");
    const label = plan.examLabel?.trim() || t("exams.examWord");
    const date = new Intl.DateTimeFormat(i18n.language, {
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(plan.examAt);
    if (plan.daysToExam === 0) return t("exams.whenToday", { label });
    return t(plan.daysToExam < 0 ? "exams.whenPast" : "exams.when", { label, date });
  };
}

/**
 * Esami: the student's exams as rows of one card, each with its three rings, its date and what to do next, then the
 * archived ones behind a toggle. Due flashcards from every exam sit as one line above the list.
 */
export function ExamsList({ menu, notice }: { menu: ReactNode; notice?: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const plans = useQuery(plansQuery);
  const rings = useQuery(ringsQuery);
  const [showArchived, setShowArchived] = useState(false);
  const all = plans.data ?? [];
  const active = all.filter((plan) => !plan.archived);
  const archived = all.filter((plan) => plan.archived);
  const ringOf = new Map(rings.data?.map((ring) => [ring.planId, ring]));

  return (
    <div className="px-exams">
      <div className="px-exams-head">
        <h1 className="title-1">{t("doors.exams")}</h1>
        <span className="px-exams-actions">
          {menu}
          <Button icon="plus" onClick={() => navigate("/plans/new")}>
            {t("exams.newPlan")}
          </Button>
        </span>
      </div>
      {notice}
      {plans.isError ? (
        <div className="px-exams-error">
          <LoadError onRetry={() => void plans.refetch()} details={errorDetails(plans.error)}>
            {t("exams.loadFailed")}
          </LoadError>
        </div>
      ) : plans.isPending ? (
        <ExamsSkeleton label={t("components.loading")} />
      ) : (
        <>
          <DueLine plans={active} rings={rings.data} />
          {rings.isError ? (
            <div className="px-exams-error">
              <Notice
                tone="danger"
                action={{ label: t("components.notice.retry"), onClick: () => void rings.refetch() }}
              >
                {t("exams.ringsFailed")}
              </Notice>
            </div>
          ) : null}
          {active.length > 0 ? (
            <ul className="px-exams-list" aria-label={t("exams.listLabel")}>
              {active.map((plan) => (
                <ExamRow key={plan.id} plan={plan} ring={ringOf.get(plan.id)} ringsPending={rings.isPending} />
              ))}
            </ul>
          ) : (
            <div className="px-exams-list px-exams-empty">
              <h2 className="title-2">
                {archived.length > 0 ? t("exams.allArchivedTitle") : t("exams.emptyTitle")}
              </h2>
              <p className="body ink-muted">
                {archived.length > 0 ? t("exams.allArchivedBody") : t("exams.emptyBody")}
              </p>
            </div>
          )}
          {archived.length > 0 ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                icon="archive"
                className="px-exams-archbtn"
                expanded={showArchived}
                onClick={() => setShowArchived(!showArchived)}
              >
                <span className="px-exams-archlabel">
                  {t("exams.statusArchived")}
                  <Icon name="chevron-down" size={14} />
                </span>
              </Button>
              {showArchived ? (
                <Reveal>
                  <ul className="px-exams-list is-archived" aria-label={t("exams.archivedLabel")}>
                    {archived.map((plan) => (
                      <ArchivedRow key={plan.id} plan={plan} ring={ringOf.get(plan.id)} />
                    ))}
                  </ul>
                </Reveal>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

/** "Oggi hai 17 flashcard da ripassare", which exams they come from, and one button to review them all. */
function DueLine({ plans, rings }: { plans: Plan[]; rings: Ring[] | undefined }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const due = plans
    .map((plan) => ({ title: plan.title, count: rings?.find((ring) => ring.planId === plan.id)?.dueCards ?? 0 }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);
  const total = due.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) return null;
  // The three largest by name, the rest as a count, so the line stays one line under the count.
  const named = due.slice(0, 3).map((entry) => t("exams.dueFrom", { count: entry.count, title: entry.title }));
  const rest = due.slice(3);
  if (rest.length > 0)
    named.push(
      t("exams.dueOthers", { count: rest.length, cards: rest.reduce((sum, entry) => sum + entry.count, 0) }),
    );
  const split = new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(named);
  return (
    <div className="px-exams-due">
      <p>
        {t("exams.due", { count: total })}
        {due.length > 1 ? <span>{split}</span> : null}
      </p>
      <Button variant="secondary" onClick={() => navigate("/cards/due")}>
        {t("exams.reviewDue", { count: total })}
      </Button>
    </div>
  );
}

function ExamRow({ plan, ring, ringsPending }: { plan: Plan; ring: Ring | undefined; ringsPending: boolean }) {
  const { t } = useTranslation();
  const when = useExamWhen();
  const { label } = useRingText(ring);
  const building = plan.status === "building";
  const next = ring?.next;
  return (
    <li>
      <Link className="px-exams-row" to={`/plans/${plan.id}`}>
        <span className="px-exams-ring">
          {building ? (
            <Logo working decorative size={40} />
          ) : ring ? (
            <ExamRings values={ring} size="sm" label={label} />
          ) : ringsPending ? (
            <ExamRings values={{ preparation: null, path: null, today: null }} size="sm" label={t("components.loading")} />
          ) : null}
        </span>
        <span className="px-exams-name">
          <span className="px-exams-title">{plan.title}</span>
          <span className="px-exams-date">{when(plan)}</span>
        </span>
        <span className="px-exams-next">
          {building ? (
            <>
              <span className="px-exams-kicker">{t("exams.building")}</span>
              {t("exams.buildingLine")}
            </>
          ) : next ? (
            <>
              <span className="px-exams-kicker">{t("exams.now")}</span>
              {next.topicTitle
                ? t("exams.next", { activity: t(`plans.path.activity.${next.activity}`), topic: next.topicTitle })
                : t(`plans.path.activity.${next.activity}`)}
            </>
          ) : ring ? (
            <>
              <span className="px-exams-kicker">{t("exams.now")}</span>
              {t("exams.nothingNext")}
            </>
          ) : null}
        </span>
        <Icon name="chevron-right" size={18} />
      </Link>
    </li>
  );
}

/** An archived exam: its name, when it was, and the preparation it ended with. */
function ArchivedRow({ plan, ring }: { plan: Plan; ring: Ring | undefined }) {
  const { t, i18n } = useTranslation();
  const grade = useGradeScale();
  const past = plan.examAt != null && plan.daysToExam != null && plan.daysToExam < 0;
  const month = past
    ? new Intl.DateTimeFormat(i18n.language, {
        month: "long",
        year: new Date(plan.examAt!).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
      }).format(plan.examAt!)
    : null;
  const when = month ? t("exams.takenIn", { month }) : t("exams.archivedOne");
  const line =
    ring?.preparation != null
      ? t("exams.archivedLine", { when, grade: grade.mastery(ring.preparation) })
      : when;
  return (
    <li>
      <Link className="px-exams-row" to={`/plans/${plan.id}`}>
        <span className="px-exams-title">{plan.title}</span>
        <span className="px-exams-date">{line}</span>
        <Icon name="chevron-right" size={18} />
      </Link>
    </li>
  );
}

/** The list's shape while it loads from this computer: a ring and two lines per row, after 150 ms. */
function ExamsSkeleton({ label }: { label: string }) {
  return (
    <div className="px-exams-list px-skeleton" role="status" aria-label={label}>
      {[46, 38, 52].map((width) => (
        <div className="px-exams-row is-skeleton" key={width} aria-hidden>
          <span className="px-exams-ring">
            <i className="px-skeleton-bar is-ring" />
          </span>
          <span className="px-exams-name">
            <i className="px-skeleton-bar is-title" style={{ width: `${width}%` }} />
            <i className="px-skeleton-bar" style={{ width: "62%" }} />
          </span>
          <span className="px-exams-name">
            <i className="px-skeleton-bar" style={{ width: "30%" }} />
            <i className="px-skeleton-bar" style={{ width: "70%" }} />
          </span>
          <span />
        </div>
      ))}
    </div>
  );
}
