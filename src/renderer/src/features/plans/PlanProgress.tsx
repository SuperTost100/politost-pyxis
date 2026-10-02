import { Button } from "antd";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
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
import { SegmentedTabs } from "../../components/SegmentedTabs";
import { openSourceViewer } from "../../components/SourceViewer";
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
  const [tab, setTab] = useState("preparation");
  const date = (
    at: number,
    options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" },
  ) => new Date(at).toLocaleDateString(i18n.language, options);
  const summary = progress.preparation;
  const gaps = progress.gaps;
  const fill = (topicId: string) =>
    navigate(`/plans/${planId}/quiz/${topicId}`);
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
      <SegmentedTabs
        label={t("progress.views")}
        value={tab}
        onChange={setTab}
        items={[
          { value: "preparation", label: t("progress.preparation") },
          { value: "simulations", label: t("progress.simulations") },
          { value: "pace", label: t("progress.paceTitle") },
        ]}
      />
      {tab === "preparation" && (
        <div className="px-preparation">
          <StatTile
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
            <h2 className="title-3">{t("progress.chart")}</h2>
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
              <h2 className="title-3">
                {t("progress.gapsCount", { count: gaps.length })}
              </h2>
              {gaps[0] && (
                <Button
                  type="primary"
                  shape="round"
                  onClick={() => fill(gaps[0]!.topicId)}
                >
                  {t("progress.fillWorst")}
                </Button>
              )}
            </div>
            {gaps.length ? (
              gaps.map((gap) => (
                <GapItem
                  key={gap.topicId}
                  topic={
                    progress.topics.find((topic) => topic.id === gap.topicId)
                      ?.title ?? gap.topicId
                  }
                  severity={gap.severity}
                  onFill={() => fill(gap.topicId)}
                  fillLabel={t("progress.fillGap")}
                  severitySevereLabel={t("progress.severe")}
                  severityMinorLabel={t("progress.minor")}
                >
                  {gap.wrongAnswers > 0
                    ? t("progress.gapAnswers", { count: gap.wrongAnswers })
                    : t("progress.gapReported")}
                </GapItem>
              ))
            ) : (
              <p className="small px-progress-empty">{t("progress.noGaps")}</p>
            )}
          </section>
          {progress.flagged.length > 0 && (
            <section className="px-progress-block">
              <h2 className="title-3">{t("progress.flagged")}</h2>
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
            <h2 className="title-3">{t("progress.skills")}</h2>
            <ul className="px-progress-skills">
              {progress.topics.map((topic) => (
                <li key={topic.id}>
                  <div>
                    <span className="body-strong">{topic.title}</span>
                    <p className="meta">
                      {t("progress.topicActivity", {
                        exercises: topic.exercisesSolved,
                        lessons: topic.lessons,
                      })}
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
            <h2 className="title-3">{t("progress.weeklyTitle")}</h2>
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
      )}
      {tab === "simulations" && (
        <section className="px-progress-block">
          <h2 className="title-3">{t("progress.simulations")}</h2>
          {simulations.length ? (
            <div className="px-progress-table-scroll">
              <table className="px-progress-simulations">
                <thead>
                  <tr>
                    {["date", "type", "duration", "score", "open"].map(
                      (key) => (
                        <th key={key} scope="col">
                          {t(`progress.${key}`)}
                        </th>
                      ),
                    )}
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
            <div className="px-progress-empty">
              <p className="body">{t("progress.noSimulations")}</p>
              <Button
                type="primary"
                shape="round"
                onClick={() => navigate(`/plans/${planId}/simulation`)}
              >
                {t("progress.startSimulation")}
              </Button>
            </div>
          )}
        </section>
      )}
      {tab === "pace" && (
        <section className="px-progress-block">
          <h2 className="title-3">{t("progress.paceTitle")}</h2>
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
                <YAxis
                  tick={tick}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                />
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
                      fillOpacity={
                        i === progress.pace.bars.length - 1 ? 1 : 0.6
                      }
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
      )}
    </section>
  );
}
