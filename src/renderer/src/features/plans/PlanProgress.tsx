import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { RequestOutput } from "@shared/ipc";
import { StatTile } from "../../components/StatTile";
import { MasteryBar } from "../../components/MasteryBar";
import { GapItem } from "../../components/GapItem";
import { Notice } from "../../components/Notice";
import { openSourceViewer } from "../../components/SourceViewer";
import { invoke } from "../../lib/ipc";
import "./PlanProgress.css";

type Progress = RequestOutput<"plans.series">;
export function PlanProgress({
  planId,
  progress,
  simulations,
}: {
  planId: string;
  progress: Progress;
  simulations: RequestOutput<"plans.simulations">;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedDrill = searchParams.get("drill");
  const startedDrill = useRef<string | null>(null);
  const date = (
    at: number,
    options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" },
  ) => new Date(at).toLocaleDateString(i18n.language, options);
  const summary = progress.preparation;
  const gaps = progress.gaps;
  const client = useQueryClient();
  // A gap opens a targeted drill built by a durable job; the page watches it and then opens the quiz.
  const [drill, setDrill] = useState<{
    topicId: string;
    gapId?: string;
  } | null>(null);
  const [drillFailed, setDrillFailed] = useState(false);
  const drillRead = useQuery({
    queryKey: ["gap-drill", planId, drill?.topicId, drill?.gapId],
    enabled: Boolean(drill),
    gcTime: 0,
    queryFn: () =>
      invoke("study.gapDrillRead", {
        planId,
        topicId: drill?.topicId ?? "",
        ...(drill?.gapId ? { gapId: drill.gapId } : {}),
      }),
    refetchInterval: (query) =>
      ["queued", "running"].includes(query.state.data?.state ?? "queued")
        ? 1500
        : false,
  });
  const drillState = drill ? (drillRead.data?.state ?? "queued") : null;
  const preparing = drillState === "queued" || drillState === "running";
  const drillStopped =
    drillFailed ||
    drillState === "failed" ||
    drillState === "cancelled" ||
    drillState === "interrupted";
  const readyAttempt =
    drill && drillState === "succeeded" ? drillRead.data?.attemptId : null;
  useEffect(() => {
    if (!drill || !readyAttempt) return;
    setDrill(null);
    navigate(`/plans/${planId}/quiz/${drill.topicId}?attempt=${readyAttempt}`);
  }, [drill, readyAttempt, planId]);
  async function fill(topicId: string, gapId?: string) {
    if (preparing) return;
    setDrillFailed(false);
    setDrill({ topicId, gapId });
    try {
      await invoke("study.gapDrillStart", {
        planId,
        topicId,
        ...(gapId ? { gapId } : {}),
      });
      await client.invalidateQueries({ queryKey: ["gap-drill", planId] });
    } catch {
      setDrill(null);
      setDrillFailed(true);
    }
  }
  useEffect(() => {
    if (!requestedDrill || startedDrill.current === requestedDrill) return;
    startedDrill.current = requestedDrill;
    void fill(requestedDrill);
  }, [requestedDrill]);
  const target = Math.round(summary.target * 100);
  const chart = progress.chart.map((point) => ({
    ...point,
    value: Math.round(point.mastery * 100),
  }));
  const tick = {
    fill: "var(--ink-muted)",
    fontSize: 12,
    fontFamily: "var(--font-mono)",
  };
  const tooltip = {
    background: "var(--surface-overlay)",
    border: "1px solid var(--border-control)",
    borderRadius: 12,
    color: "var(--ink)",
    fontFamily: "var(--font-sans)",
  };
  return (
    <section className="px-plan-progress" aria-label={t("progress.title")}>
      <section
        className="px-progress-section"
        aria-labelledby="px-progress-preparation"
      >
        <h2 id="px-progress-preparation" className="title-3">
          {t("progress.preparation")}
        </h2>
        <div className="px-preparation">
          <StatTile
            compact
            label={t("progress.forecast")}
            value={Math.round(summary.mastery * 100)}
            target={target}
            pills={[
              t("progress.target", { value: target }),
              t("progress.weeklyChange", {
                value: `${summary.weeklyChange >= 0 ? "+" : ""}${Math.round(summary.weeklyChange * 100)}`,
              }),
            ]}
            stats={[
              {
                value: `${summary.onTrack} / ${summary.totalTopics}`,
                label: t("progress.topicsOnTrack"),
              },
              {
                value: String(summary.lessons),
                label: t("progress.lessonsDone"),
              },
            ]}
          />
          <section className="px-progress-block">
            <h3 className="title-3">{t("progress.chart")}</h3>
            <div className="px-progress-chart">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chart}
                  margin={{ top: 24, right: 24, bottom: 8, left: 0 }}
                  accessibilityLayer
                  aria-label={t("progress.chart")}
                >
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis
                    dataKey="day"
                    tickFormatter={(at) => date(Number(at))}
                    tick={tick}
                    axisLine={false}
                    tickLine={false}
                    minTickGap={32}
                  />
                  <YAxis
                    domain={[0, 100]}
                    ticks={[0, 25, 50, 75, 100]}
                    tickFormatter={(value) => `${value}%`}
                    tick={tick}
                    axisLine={false}
                    tickLine={false}
                    width={44}
                  />
                  <Tooltip
                    labelFormatter={(at) =>
                      date(Number(at), { day: "numeric", month: "long" })
                    }
                    formatter={(value) => [
                      `${value}%`,
                      t("progress.preparation"),
                    ]}
                    contentStyle={tooltip}
                  />
                  <ReferenceLine
                    y={target}
                    stroke="var(--border-control)"
                    strokeDasharray="5 5"
                    label={{
                      value: t("progress.target", { value: target }),
                      position: "insideTopRight",
                      fill: "var(--ink-muted)",
                      fontSize: 12,
                    }}
                  />
                  <Line
                    dataKey="value"
                    type="linear"
                    stroke="var(--primary)"
                    strokeWidth={2}
                    isAnimationActive={false}
                    activeDot={{ r: 4 }}
                    dot={(props) =>
                      props.index === chart.length - 1 ? (
                        <circle
                          key="last"
                          cx={props.cx}
                          cy={props.cy}
                          r={4}
                          fill="var(--primary)"
                        />
                      ) : (
                        <g key={props.index} />
                      )
                    }
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>
          <section className="px-progress-block">
            <div className="px-progress-section-head">
              <h3 className="title-3">
                {t("progress.gapsCount", { count: gaps.length })}
              </h3>
              {gaps[0] && (
                <Button
                  type="primary"
                  shape="round"
                  disabled={preparing}
                  onClick={() => void fill(gaps[0]!.topicId, gaps[0]!.gapId)}
                >
                  {t("progress.fillWorst")}
                </Button>
              )}
            </div>
            {preparing ? (
              <Notice
                tone="info"
                action={
                  drillRead.data
                    ? {
                        label: t("jobs.cancel"),
                        onClick: () =>
                          void invoke("jobs.cancel", {
                            jobId: drillRead.data?.jobId ?? "",
                          }).then(() =>
                            client.invalidateQueries({
                              queryKey: ["gap-drill", planId],
                            }),
                          ),
                      }
                    : undefined
                }
              >
                {t("progress.drillBuilding")}
              </Notice>
            ) : drillStopped && drill ? (
              <Notice
                tone={drillState === "cancelled" ? "info" : "danger"}
                action={{
                  label: t("progress.drillRetry"),
                  onClick: () => void fill(drill.topicId, drill.gapId),
                }}
              >
                {t(
                  drillState === "cancelled"
                    ? "progress.drillCancelled"
                    : "progress.drillFailed",
                )}
              </Notice>
            ) : drillFailed ? (
              <Notice tone="danger">{t("progress.drillFailed")}</Notice>
            ) : null}
            {gaps.length ? (
              gaps.map((gap) => {
                const topic =
                  progress.topics.find((item) => item.id === gap.topicId)
                    ?.title ?? gap.topicId;
                // PRO-02: a topic can hold several gaps, one per distinct misconception.
                const several =
                  gaps.filter((item) => item.topicId === gap.topicId).length >
                  1;
                const text = gap.misconception
                  ? gap.misconception
                  : gap.misses[0]
                    ? gap.misses[0].explanation
                      ? t("progress.gapMissExplained", {
                          question: gap.misses[0].question,
                          explanation: gap.misses[0].explanation,
                        })
                      : t("progress.gapMiss", {
                          question: gap.misses[0].question,
                          expected: gap.misses[0].expected,
                        })
                    : gap.wrongAnswers > 0
                      ? t("progress.gapAnswers", { count: gap.wrongAnswers })
                      : t("progress.gapReported");
                return (
                  <GapItem
                    key={gap.gapId}
                    topic={topic}
                    severity={gap.severity}
                    onFill={() => void fill(gap.topicId, gap.gapId)}
                    fillLabel={t("progress.fillGap")}
                    fillName={
                      several ? `${topic}: ${text.slice(0, 80)}` : undefined
                    }
                    fillDisabled={preparing}
                    severitySevereLabel={t("progress.severe")}
                    severityMinorLabel={t("progress.minor")}
                  >
                    {text}
                    {gap.unmerged ? (
                      <span className="small ink-muted px-gap-note">
                        {t("progress.gapUnmerged")}
                      </span>
                    ) : null}
                  </GapItem>
                );
              })
            ) : (
              <p className="small px-progress-empty">{t("progress.noGaps")}</p>
            )}
          </section>
          {progress.flagged.length > 0 && (
            <section className="px-progress-block">
              <h3 className="title-3">{t("progress.flagged")}</h3>
              <ul className="px-progress-flags">
                {progress.flagged.map((flag) => (
                  <li key={flag.id}>
                    <div>
                      <span className="body-strong">{flag.label}</span>
                      <p className="small">{flag.reason}</p>
                    </div>
                    {flag.targetKind === "passage" ? (
                      <Button
                        shape="round"
                        onClick={() =>
                          openSourceViewer({ passageId: flag.targetId })
                        }
                      >
                        {t("progress.open")}
                      </Button>
                    ) : flag.topicId ? (
                      <Button
                        shape="round"
                        onClick={() =>
                          navigate(`/plans/${planId}/lesson/${flag.topicId}`)
                        }
                      >
                        {t("progress.open")}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="px-progress-block">
            <h3 className="title-3">{t("progress.skills")}</h3>
            <ul className="px-progress-skills">
              {progress.topics.map((topic) => (
                <li key={topic.id}>
                  <div>
                    <span className="body-strong">{topic.title}</span>
                    <p className="meta">
                      {t("progress.topicExercises", {
                        count: topic.exercisesSolved,
                      })}{" "}
                      · {t("progress.topicLessons", { count: topic.lessons })}
                    </p>
                    <p className="meta">
                      {topic.lastStudied
                        ? t("progress.lastStudied", {
                            date: date(topic.lastStudied),
                          })
                        : t("progress.neverStudied")}
                    </p>
                  </div>
                  <MasteryBar
                    value={Math.round(topic.mastery * 100)}
                    target={target}
                    label={topic.title}
                  />
                </li>
              ))}
            </ul>
          </section>
          <section className="px-progress-block">
            <h3 className="title-3">{t("progress.weeklyTitle")}</h3>
            <div className="px-progress-table-scroll">
              <table
                className="px-progress-weekly"
                aria-label={t("progress.weeklyTitle")}
              >
                <thead>
                  <tr>
                    <th scope="col">{t("progress.topic")}</th>
                    {progress.weeks.map((week) => (
                      <th scope="col" key={week}>
                        {date(week)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {progress.topics.map((topic) => (
                    <tr key={topic.id}>
                      <th scope="row">
                        <span>{topic.title}</span>
                        {topic.idle && (
                          <span className="px-progress-idle meta">
                            <TriangleAlert size={14} aria-hidden />
                            {t("progress.idleForWeeks")}
                          </span>
                        )}
                      </th>
                      {(
                        progress.counts[topic.id] ?? progress.weeks.map(() => 0)
                      ).map((count, i) => (
                        <td key={i}>
                          <span
                            className={`px-progress-cell level-${count === 0 ? 0 : count <= 3 ? 1 : count <= 9 ? 2 : 3}`}
                          >
                            {count}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </section>
      <section
        className="px-progress-section"
        aria-labelledby="px-progress-simulations"
      >
        <h2 id="px-progress-simulations" className="title-3">
          {t("progress.simulations")}
        </h2>
        {simulations.length ? (
          <div className="px-progress-table-scroll">
            <table className="px-progress-simulations">
              <thead>
                <tr>
                  {["date", "type", "duration", "score", "open"].map((key) => (
                    <th key={key} scope="col">
                      {t(`progress.${key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {simulations.map((run) => (
                  <tr key={run.id}>
                    <td>{date(run.at)}</td>
                    <td>{t("simulation.title")}</td>
                    <td>{t("simulation.minutes", { count: run.minutes })}</td>
                    <td>{Math.round(run.score * 100)} / 100</td>
                    <td>
                      <Button
                        shape="round"
                        aria-label={t("progress.openExam", {
                          date: date(run.at),
                        })}
                        onClick={() =>
                          navigate(`/plans/${planId}/exam/${run.id}`)
                        }
                      >
                        {t("progress.open")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="body px-progress-empty">
            {t("progress.noSimulations")}{" "}
            <Button
              type="link"
              className="px-progress-inline-action"
              onClick={() => navigate(`/plans/${planId}/simulation`)}
            >
              {t("progress.startSimulation")}
            </Button>
          </p>
        )}
      </section>
      <section
        className="px-progress-section"
        aria-labelledby="px-progress-pace"
      >
        <h2 id="px-progress-pace" className="title-3">
          {t("progress.paceTitle")}
        </h2>
        <div className="px-progress-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={progress.pace.bars.map((point) => ({
                ...point,
                minutes: Math.round(point.seconds / 60),
              }))}
              margin={{ top: 16, right: 16, bottom: 8, left: 0 }}
              accessibilityLayer
              aria-label={t("progress.timeChart")}
            >
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis
                dataKey="day"
                tickFormatter={(at) => date(Number(at))}
                tick={tick}
                axisLine={false}
                tickLine={false}
                minTickGap={32}
              />
              <YAxis tick={tick} axisLine={false} tickLine={false} width={44} />
              <Tooltip
                labelFormatter={(at) => date(Number(at))}
                formatter={(value) => [
                  t("progress.minutesValue", { count: Number(value) }),
                  t("progress.studyTime"),
                ]}
                contentStyle={tooltip}
              />
              <Bar
                dataKey="minutes"
                fill="var(--primary)"
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              >
                {progress.pace.bars.map((point, i) => (
                  <Cell
                    key={point.day}
                    fillOpacity={i === progress.pace.bars.length - 1 ? 1 : 0.6}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <dl className="px-progress-pace-facts">
          <div>
            <dt>{t("progress.thisWeek")}</dt>
            <dd>
              {t("progress.minutesValue", {
                count: progress.pace.weekMinutes,
              })}
            </dd>
          </div>
          <div>
            <dt>{t("progress.lessonsDone")}</dt>
            <dd>{progress.pace.weekLessons}</dd>
          </div>
          <div>
            <dt>{t("progress.mostActive")}</dt>
            <dd>
              {progress.pace.mostActiveWeekday === null
                ? t("progress.noActivity")
                : t(`progress.weekdays.${progress.pace.mostActiveWeekday}`)}
            </dd>
          </div>
        </dl>
      </section>
    </section>
  );
}
