import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, InputNumber } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { ArrowLeft, ChevronLeft, ChevronRight, GraduationCap } from "lucide-react";
import type { RequestOutput } from "@shared/ipc";
import { EmptyState } from "../../app/layouts/TaskLayouts";
import { MasteryBar } from "../../components/MasteryBar";
import { Notice } from "../../components/Notice";
import { SegmentedTabs } from "../../components/SegmentedTabs";
import { Tag } from "../../components/Tag";
import { invoke } from "../../lib/ipc";
import { examDaysLabel } from "../plans/examDays";
import { behindText, formatMinutes, plannerDate } from "./plannerFormat";
import "./PlannerPage.css";

type Planner = RequestOutput<"plans.planner">;

/**
 * The session planner: every dated exam, the hours the student can study each week, and each exam's remaining work
 * spread over the weeks and days before it. It is worked out again from the current state on every visit, so a missed
 * day re-plans the rest.
 */
export function PlannerPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const planner = useQuery({
    queryKey: ["plans", "planner"],
    queryFn: () => invoke("plans.planner", {}),
  });
  const [view, setView] = useState("weeks");
  const [week, setWeek] = useState(0);
  const [failed, setFailed] = useState(false);
  async function save(input: { week?: string; hours: number | null }) {
    setFailed(false);
    try {
      await invoke("plans.plannerHours", input);
      // Oggi reads the same plan, under the same key prefix.
      await client.invalidateQueries({ queryKey: ["plans"] });
    } catch {
      setFailed(true);
    }
  }
  const short = new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short" });
  const long = new Intl.DateTimeFormat(i18n.language, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const range = (start: string) => {
    const from = plannerDate(start);
    const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 6);
    return short.formatRange(from, to);
  };
  const data = planner.data;
  const titles = new Map(data?.exams.map((exam) => [exam.planId, exam.title]));
  const weeks = data?.weeks ?? [];
  const shownWeek = weeks[Math.min(week, weeks.length - 1)];
  // The days the plan can use: from today to the day before the last exam. A week partly outside them has less time.
  const studyDays = (data?.days ?? []).slice(0, -1).map((day) => day.date);
  const freeMinutes = (item: Planner["weeks"][number]) => {
    const start = plannerDate(item.start).getTime();
    const end = start + 7 * 86_400_000;
    const count = studyDays.filter((date) => {
      const at = plannerDate(date).getTime();
      return at >= start && at < end;
    }).length;
    return (item.hours * 60 * count) / 7;
  };

  return (
    <div className="px-planner">
      <Link to="/exams" className="px-planner-back">
        <ArrowLeft size={16} aria-hidden />
        {t("doors.exams")}
      </Link>
      <h1 className="title-1">{t("planner.title")}</h1>
      <p className="body ink-muted px-planner-intro">{t("planner.intro")}</p>
      {planner.isError ? <Notice tone="danger">{t("planner.failed")}</Notice> : null}
      {!data ? null : data.exams.length === 0 ? (
        <EmptyState
          title={t("planner.emptyTitle")}
          body={t("planner.emptyBody")}
          action={
            <Button shape="round" size="large" onClick={() => navigate("/exams")}>
              {t("planner.toExams")}
            </Button>
          }
        />
      ) : (
        <>
          <div className="px-planner-hours">
            <label htmlFor="planner-hours" className="body-strong">
              {t("planner.weeklyHours")}
            </label>
            <HoursInput
              id="planner-hours"
              value={data.weeklyHours}
              placeholder={data.neededHours != null ? String(data.neededHours) : undefined}
              onSave={(hours) => void save({ hours })}
            />
            {data.neededHours != null ? (
              <p className="small ink-muted">
                {t("planner.needed", { hours: data.neededHours })}
              </p>
            ) : null}
          </div>
          {failed ? <Notice tone="danger">{t("planner.saveFailed")}</Notice> : null}
          {data.exams
            .filter((exam) => exam.behind)
            .map((exam) => (
              <Notice key={exam.planId} tone="warning">
                {behindText(t, exam)}
              </Notice>
            ))}
          <section className="px-planner-section" aria-labelledby="planner-exams">
            <h2 className="title-3" id="planner-exams">
              {t("planner.exams")}
            </h2>
            <ul className="px-planner-exams">
              {data.exams.map((exam) => (
                <li key={exam.planId} className="px-planner-exam">
                  <div className="px-planner-exam-head">
                    <Link to={`/plans/${exam.planId}`} className="body-strong">
                      {exam.title}
                    </Link>
                    <span className="meta ink-muted">
                      {long.format(plannerDate(exam.examDate))} ·{" "}
                      {examDaysLabel(t, exam.daysToExam)}
                    </span>
                  </div>
                  <MasteryBar
                    value={Math.round(exam.mastery * 100)}
                    target={exam.target * 100}
                    label={t("planner.masteryOf", { title: exam.title })}
                  />
                  <p className="small ink-muted">
                    {exam.remainingMinutes > 0
                      ? t("planner.left", { time: formatMinutes(t, exam.remainingMinutes) })
                      : t("planner.nothingLeft")}
                  </p>
                </li>
              ))}
            </ul>
          </section>
          {weeks.length === 0 ? (
            <p className="body ink-muted">{t("planner.setHours")}</p>
          ) : (
            <section className="px-planner-section" aria-label={t("planner.views")}>
              <SegmentedTabs
                label={t("planner.views")}
                value={view}
                onChange={setView}
                items={[
                  { value: "weeks", label: t("planner.byWeek") },
                  { value: "days", label: t("planner.byDay") },
                ]}
              />
              {view === "weeks" ? (
                <ol className="px-planner-weeks">
                  {weeks.map((item, index) => {
                    const planned = item.plans.reduce((sum, entry) => sum + entry.minutes, 0);
                    return (
                      <li key={item.start} className="px-planner-week">
                        <div className="px-planner-week-head">
                          <h3 className="body-strong">
                            {index === 0 ? t("planner.thisWeek") : range(item.start)}
                          </h3>
                          <div className="px-planner-week-hours">
                            <HoursInput
                              value={item.hours}
                              small
                              label={t("planner.weekHours", { week: range(item.start) })}
                              onSave={(hours) => void save({ week: item.start, hours })}
                            />
                            {item.custom ? (
                              <Button
                                type="text"
                                shape="round"
                                size="small"
                                onClick={() => void save({ week: item.start, hours: null })}
                              >
                                {t("planner.usual")}
                              </Button>
                            ) : null}
                          </div>
                        </div>
                        <p className="small ink-muted">
                          {t("planner.planned", {
                            time: formatMinutes(t, planned),
                            free: formatMinutes(t, freeMinutes(item)),
                          })}
                        </p>
                        <PlanLines plans={item.plans} titles={titles} />
                        {item.exams.map((planId) => (
                          <ExamMark key={planId} title={titles.get(planId) ?? ""} />
                        ))}
                      </li>
                    );
                  })}
                </ol>
              ) : shownWeek ? (
                <DayView
                  planner={data}
                  week={shownWeek}
                  label={range(shownWeek.start)}
                  first={week === 0}
                  last={week >= weeks.length - 1}
                  onMove={(step) => setWeek((current) => Math.max(0, current + step))}
                  titles={titles}
                  format={(date) => long.format(plannerDate(date))}
                />
              ) : null}
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** One week's days: the minutes each exam gets, and the exam days. */
function DayView(props: {
  planner: Planner;
  week: Planner["weeks"][number];
  label: string;
  first: boolean;
  last: boolean;
  onMove: (step: number) => void;
  titles: Map<string, string>;
  format: (date: string) => string;
}) {
  const { t } = useTranslation();
  const start = props.week.start;
  const end = (() => {
    const date = plannerDate(start);
    date.setDate(date.getDate() + 7);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  })();
  const days = props.planner.days.filter((day) => day.date >= start && day.date < end);
  const today = props.planner.days[0]?.date;
  return (
    <div className="px-planner-days">
      <div className="px-planner-days-nav">
        <Button
          shape="circle"
          aria-label={t("planner.previousWeek")}
          title={t("planner.previousWeek")}
          icon={<ChevronLeft size={18} strokeWidth={1.75} aria-hidden />}
          onClick={() => props.onMove(-1)}
          disabled={props.first}
        />
        <h3 className="body-strong" aria-live="polite">
          {props.label}
        </h3>
        <Button
          shape="circle"
          aria-label={t("planner.nextWeek")}
          title={t("planner.nextWeek")}
          icon={<ChevronRight size={18} strokeWidth={1.75} aria-hidden />}
          onClick={() => props.onMove(1)}
          disabled={props.last}
        />
      </div>
      <ol className="px-planner-day-list">
        {days.map((day) => (
          <li key={day.date} className="px-planner-day">
            <div className="px-planner-day-date">
              <span className="body-strong">{props.format(day.date)}</span>
              {day.date === today ? <Tag>{t("planner.today")}</Tag> : null}
            </div>
            <div className="px-planner-day-work">
              {day.plans.length === 0 && day.exams.length === 0 ? (
                <span className="small ink-muted">{t("planner.free")}</span>
              ) : null}
              <PlanLines plans={day.plans} titles={props.titles} />
              {day.exams.map((planId) => (
                <ExamMark key={planId} title={props.titles.get(planId) ?? ""} />
              ))}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function PlanLines(props: {
  plans: Array<{ planId: string; minutes: number }>;
  titles: Map<string, string>;
}) {
  const { t } = useTranslation();
  if (!props.plans.length) return null;
  return (
    <ul className="px-planner-lines">
      {props.plans.map((entry) => (
        <li key={entry.planId}>
          <span className="small">{props.titles.get(entry.planId)}</span>
          <span className="meta ink-muted">{formatMinutes(t, entry.minutes)}</span>
        </li>
      ))}
    </ul>
  );
}

function ExamMark({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <p className="px-planner-exam-mark small">
      <GraduationCap size={16} strokeWidth={1.75} aria-hidden />
      {t("planner.examDay", { title })}
    </p>
  );
}

/** Hours a week, saved when the field loses focus or on Enter. Empty clears the value. */
function HoursInput(props: {
  id?: string;
  value: number | null;
  placeholder?: string;
  small?: boolean;
  label?: string;
  onSave: (hours: number | null) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<number | null>(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => {
    if (draft !== props.value) props.onSave(draft);
  };
  return (
    <InputNumber
      id={props.id}
      aria-label={props.label}
      className={props.small ? "px-planner-hours-input is-small" : "px-planner-hours-input"}
      size={props.small ? "small" : "middle"}
      min={0}
      max={100}
      step={1}
      placeholder={props.placeholder}
      value={draft}
      suffix={t("planner.hoursUnit")}
      onChange={(value) => setDraft(typeof value === "number" ? value : null)}
      onBlur={commit}
      onPressEnter={commit}
    />
  );
}
