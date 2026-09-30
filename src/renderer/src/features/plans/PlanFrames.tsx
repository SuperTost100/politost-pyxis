import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { CanvasLayout, FocusLayout } from "../../app/layouts/TaskLayouts";
import { invoke } from "../../lib/ipc";

export function WizardFrame() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const sources = useQuery({
    queryKey: ["sources"],
    queryFn: () => invoke("sources.list", {}),
  });
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function create() {
    const name = title.trim();
    if (!name || picked.length === 0 || busy) return;
    setBusy(true);
    await invoke("plans.create", { title: name, sourceIds: picked });
    await client.invalidateQueries({ queryKey: ["plans"] });
    navigate("/exams");
  }

  return (
    <FocusLayout
      title={t("wizard.title")}
      secondary={
        <Button type="text" shape="round" onClick={() => navigate("/exams")}>
          {t("nav.back")}
        </Button>
      }
    >
      <p className="body ink-muted">{t("wizard.body")}</p>
      <label className="label" htmlFor="plan-title">
        {t("wizard.planTitle")}
      </label>
      <input
        id="plan-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <div className="choice-list">
        {(sources.data ?? []).map((source) => (
          <button
            key={source.id}
            type="button"
            className={picked.includes(source.id) ? "choice is-selected" : "choice"}
            aria-pressed={picked.includes(source.id)}
            onClick={() =>
              setPicked((current) =>
                current.includes(source.id)
                  ? current.filter((id) => id !== source.id)
                  : [...current, source.id],
              )
            }
          >
            {source.title}
          </button>
        ))}
      </div>
      <Button
        type="primary"
        shape="round"
        disabled={busy || title.trim() === "" || picked.length === 0}
        onClick={() => void create()}
      >
        {t("wizard.create")}
      </Button>
    </FocusLayout>
  );
}

export function PlanPage() {
  const { t } = useTranslation();
  const { planId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const plan = useQuery({
    queryKey: ["plan", planId],
    enabled: Boolean(planId),
    queryFn: () => invoke("plans.read", { planId: planId ?? "" }),
  });
  const mastery = useQuery({
    queryKey: ["mastery", planId],
    enabled: Boolean(planId),
    queryFn: () => invoke("plans.mastery", { planId: planId ?? "" }),
  });
  const series = useQuery({
    queryKey: ["series", planId],
    enabled: Boolean(planId),
    queryFn: () => invoke("plans.series", { planId: planId ?? "" }),
  });
  const progress = series.data;
  const onTrack = (progress?.topics ?? []).filter((topic) => topic.mastery >= 0.8).length;
  const chart = progress?.chart ?? [];
  const chartWidth = 280;
  const chartHeight = 72;
  const chartStep = chart.length > 1 ? chartWidth / (chart.length - 1) : chartWidth;
  const chartPath = chart
    .map((point, index) => {
      const command = index === 0 ? "M" : "L";
      return `${command} ${index * chartStep} ${chartHeight - point.mastery * chartHeight}`;
    })
    .join(" ");
  return (
    <FocusLayout
      title={plan.data?.title ?? t("wizard.title")}
      secondary={
        <Button type="text" shape="round" onClick={() => navigate("/exams")}>
          {t("nav.back")}
        </Button>
      }
      primary={
        <Button
          shape="round"
          onClick={() => {
            if (!planId) return;
            void invoke("plans.export", { planId }).then((file) => {
              const blob = new Blob([JSON.stringify(file)], { type: "application/json" });
              const link = document.createElement("a");
              link.href = URL.createObjectURL(blob);
              link.download = `${file.title}.pyxis.json`;
              link.click();
              URL.revokeObjectURL(link.href);
            });
          }}
        >
          {t("plans.export")}
        </Button>
      }
    >
      {progress ? (
        <section>
          <h2 className="title-3">{t("progress.title")}</h2>
          <p className="small">
            {t("progress.onTrack", { ready: onTrack, total: progress.topics.length })}
          </p>
          <p className="small">{t("progress.lessons", { count: progress.lessons })}</p>
          <p className="small">{t("progress.chart")}</p>
          <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} width="100%" height={chartHeight} role="img">
            <path d={chartPath} fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          <p className="small">{t("progress.week", { count: progress.pace.week })}</p>
          <p className="small">{t("progress.peak", { count: progress.pace.peakCount })}</p>
          <h3 className="body-strong">{t("progress.gaps")}</h3>
          {progress.gaps.length === 0 ? (
            <p className="small">{t("progress.noGaps")}</p>
          ) : (
            <ul className="choice-list">
              {progress.gaps.map((gap) => (
                <li key={gap.topicId} className="small">
                  {progress.topics.find((topic) => topic.id === gap.topicId)?.title ?? gap.topicId}
                </li>
              ))}
            </ul>
          )}
          <table>
            <tbody>
              {progress.topics.map((topic) => (
                <tr key={topic.id}>
                  <th scope="row">
                    {topic.title}
                    {topic.idle ? ` · ${t("progress.idle")}` : ""}
                  </th>
                  {(progress.counts[topic.id] ?? []).map((count, index) => (
                    <td key={progress.weeks[index] ?? index}>{count}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {(mastery.data ?? []).length > 0 ? (
        <ul className="choice-list">
          {(mastery.data ?? []).map((topic) => (
            <li key={topic.id} className="small">
              {topic.title} · {Math.round(topic.mastery * 100)}
            </li>
          ))}
        </ul>
      ) : null}
      <ol className="choice-list">
        {(plan.data?.nodes ?? []).map((node) => (
          <li key={node.id}>
            <button
              type="button"
              className="choice"
              disabled={node.state === "locked"}
              onClick={() => {
                if (!planId) return;
                if (node.kind === "learn" && node.topicId) {
                  navigate(`/plans/${planId}/lesson/${node.topicId}`);
                  return;
                }
                if (node.kind === "practice" && node.topicId) {
                  navigate(`/plans/${planId}/practice/${node.topicId}`);
                  return;
                }
                if (node.kind === "cards" && node.topicId) {
                  navigate(`/plans/${planId}/cards/${node.topicId}`);
                  return;
                }
                if (node.kind === "simulation") {
                  navigate(`/plans/${planId}/simulation`);
                  return;
                }
                void invoke("plans.complete", { planId, nodeId: node.id }).then(() => {
                  void client.invalidateQueries({ queryKey: ["plan", planId] });
                  void client.invalidateQueries({ queryKey: ["mastery", planId] });
                });
              }}
            >
              <span className="body-strong">{node.title}</span>
              <span className="small">
                {t(`plans.${node.kind}`)}
                {node.state === "current" ? ` · ${t("plans.current")}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <Button
        type="text"
        danger
        shape="round"
        onClick={() => {
          if (!planId || !window.confirm(t("plans.delete"))) return;
          void invoke("plans.delete", { planId }).then(() => {
            void client.invalidateQueries({ queryKey: ["plans"] });
            navigate("/exams");
          });
        }}
      >
        {t("plans.delete")}
      </Button>
    </FocusLayout>
  );
}

export function SharedPlanPage() {
  const { t } = useTranslation();
  return (
    <div>
      <h1 className="title-1">{t("shared.title")}</h1>
      <p className="body ink-muted">{t("shared.body")}</p>
    </div>
  );
}

export function WhiteboardFrame() {
  const { t } = useTranslation();
  return (
    <CanvasLayout title={t("tools.whiteboardTitle")}>
      <p className="body ink-muted" style={{ padding: 24 }}>
        {t("tools.whiteboardBody")}
      </p>
    </CanvasLayout>
  );
}
