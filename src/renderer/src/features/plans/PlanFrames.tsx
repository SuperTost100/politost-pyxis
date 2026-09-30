import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { CanvasLayout, FocusLayout } from "../../app/layouts/TaskLayouts";
import { BuildingMark } from "../../components/BuildingMark";
import { invoke } from "../../lib/ipc";
import { examInstant, planFileSchema, reachableTarget } from "@shared/plan-file";

export function WizardFrame() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const sources = useQuery({
    queryKey: ["sources"],
    queryFn: () => invoke("sources.list", {}),
  });
  const subjects = useQuery({
    queryKey: ["subjects"],
    queryFn: () => invoke("subjects.list", {}),
  });
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [examChoice, setExamChoice] = useState<"1" | "2" | "3" | "10">("10");
  const [date, setDate] = useState("");
  const [target, setTarget] = useState(75);
  const [language, setLanguage] = useState(i18n.language.startsWith("en") ? "en" : "it");
  const [style, setStyle] = useState<"read" | "practice" | "decide">("decide");
  const [busy, setBusy] = useState(false);
  const [built, setBuilt] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function create() {
    const name = title.trim();
    if (!name || picked.length === 0 || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const days = examChoice === "1" ? 1 : examChoice === "2" ? 2 : examChoice === "3" ? 3 : 10;
      const fromDate = date ? new Date(`${date}T12:00:00`).getTime() : examInstant(days);
      const result = await invoke("plans.create", {
        title: name,
        subject: subject.trim() || undefined,
        sourceIds: picked,
        examAt: Number.isFinite(fromDate) ? fromDate : null,
        target: target / 100,
        language: language === "en" ? "en" : "it",
        style,
      });
      await client.invalidateQueries({ queryKey: ["plans"] });
      setBuilt(result.planId);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (busy || built || failed) {
    const name = title.trim();
    return (
      <FocusLayout title={t("wizard.preparing", { title: name })} closable={!busy}>
        <BuildingMark
          inner={busy ? 0.45 : 1}
          middle={built ? 1 : 0}
          outer={built ? 1 : 0}
          done={Boolean(built)}
          failedTrail={failed ? 0 : undefined}
        />
        <p className="title-2">{t("wizard.preparing", { title: name })}</p>
        <ul className="choice-list">
          <li className="small">{t("wizard.stepSources")}</li>
          <li className="small">{t("wizard.stepTopics")}</li>
          <li className="small">{t("wizard.stepPath")}</li>
        </ul>
        {failed ? <p className="small">{t("wizard.failed")}</p> : null}
        {built ? (
          <Button type="primary" shape="round" onClick={() => navigate(`/plans/${built}`)}>
            {t("wizard.open")}
          </Button>
        ) : null}
        {failed ? (
          <Button shape="round" onClick={() => void create()}>
            {t("wizard.retry")}
          </Button>
        ) : null}
      </FocusLayout>
    );
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
      <label className="label" htmlFor="plan-subject">
        {t("wizard.subject")}
      </label>
      <input
        id="plan-subject"
        list="plan-subjects"
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
      />
      <datalist id="plan-subjects">
        {(subjects.data ?? []).map((item) => (
          <option key={item.id} value={item.name} />
        ))}
      </datalist>
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
      <div className="label section-label">{t("wizard.exam")}</div>
      <div className="choice-list">
        {(
          [
            ["1", t("wizard.tomorrow")],
            ["2", t("wizard.inTwo")],
            ["3", t("wizard.inThree")],
            ["10", t("wizard.inTen")],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={!date && examChoice === id ? "choice is-selected" : "choice"}
            aria-pressed={!date && examChoice === id}
            onClick={() => {
              setDate("");
              setExamChoice(id);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="label" htmlFor="plan-date">
        {t("wizard.examDate")}
      </label>
      <input
        id="plan-date"
        type="date"
        value={date}
        onChange={(event) => setDate(event.target.value)}
      />
      <label className="label" htmlFor="plan-target">
        {t("wizard.target", { score: target })}
      </label>
      <input
        id="plan-target"
        type="range"
        min={50}
        max={100}
        step={5}
        value={target}
        aria-valuetext={t("wizard.target", { score: target })}
        onChange={(event) => setTarget(Number(event.target.value))}
      />
      <div className="label section-label">{t("wizard.language")}</div>
      <div className="choice-list">
        {(
          [
            ["it", t("wizard.italian")],
            ["en", t("wizard.english")],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={language === id ? "choice is-selected" : "choice"}
            aria-pressed={language === id}
            onClick={() => setLanguage(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="label section-label">{t("wizard.style")}</div>
      <div className="choice-list">
        {(
          [
            ["read", t("wizard.read")],
            ["practice", t("wizard.practice")],
            ["decide", t("wizard.decide")],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={style === id ? "choice is-selected" : "choice"}
            aria-pressed={style === id}
            onClick={() => setStyle(id)}
          >
            {label}
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
  const simulations = useQuery({
    queryKey: ["simulations", planId],
    enabled: Boolean(planId),
    queryFn: () => invoke("plans.simulations", { planId: planId ?? "" }),
  });
  const series = useQuery({
    queryKey: ["series", planId],
    enabled: Boolean(planId),
    queryFn: () => invoke("plans.series", { planId: planId ?? "" }),
  });
  const progress = series.data;
  const onTrack = (progress?.topics ?? []).filter(
    (topic) => topic.mastery >= reachableTarget(plan.data?.target ?? 0.8),
  ).length;
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
              document.body.append(link);
              link.click();
              link.remove();
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
          <svg
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            width="100%"
            height={chartHeight}
            role="img"
            aria-label={t("progress.chart")}
          >
            <path d={chartPath} fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          <p className="small">{t("progress.week", { count: progress.pace.week })}</p>
          <p className="small">{t("progress.minutes", { count: progress.minutes })}</p>
          <p className="small">
            {t("progress.peak", {
              day: new Date(progress.pace.peakDay).toLocaleDateString(undefined, {
                weekday: "long",
                day: "numeric",
                month: "short",
              }),
            })}
          </p>
          <h3 className="body-strong">{t("progress.simulations")}</h3>
          {(simulations.data ?? []).length === 0 ? (
            <>
              <p className="small">{t("progress.noSimulations")}</p>
              <Button shape="round" onClick={() => navigate(`/plans/${planId ?? ""}/simulation`)}>
                {t("progress.startSimulation")}
              </Button>
            </>
          ) : (
            <ul className="choice-list">
              {(simulations.data ?? []).map((run) => (
                <li key={run.id} className="small">
                  {new Date(run.at).toLocaleDateString()}
                  {" · "}
                  {t("progress.simulationRow", {
                    score: Math.round(run.score * 100),
                    minutes: run.minutes,
                  })}
                </li>
              ))}
            </ul>
          )}
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
                if (node.kind === "diagnostic") {
                  navigate(`/plans/${planId}/diagnostic`);
                  return;
                }
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
  const navigate = useNavigate();
  const client = useQueryClient();
  const [url, setUrl] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function take(): boolean {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    return true;
  }

  function drop(): void {
    pending.current = false;
    setBusy(false);
  }

  async function openText(text: string) {
    let parsed: ReturnType<typeof planFileSchema.safeParse>;
    try {
      parsed = planFileSchema.safeParse(JSON.parse(text));
    } catch {
      setNote(t("shared.bad"));
      return;
    }
    if (!parsed.success) {
      setNote(t("shared.bad"));
      return;
    }
    const result = await invoke("plans.import", parsed.data);
    await client.invalidateQueries({ queryKey: ["plans"] });
    navigate(`/plans/${result.planId}`);
  }

  return (
    <div>
      <h1 className="title-1">{t("shared.title")}</h1>
      <p className="body ink-muted">{t("shared.body")}</p>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file || !take()) return;
          void file
            .text()
            .then(openText)
            .catch(() => setNote(t("shared.bad")))
            .finally(drop);
        }}
      />
      <Button shape="round" disabled={busy} onClick={() => fileRef.current?.click()}>
        {t("shared.file")}
      </Button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const link = url.trim();
          if (!link || !take()) return;
          void window.pyxis
            .fetchPlan(link)
            .then(openText)
            .catch(() => setNote(t("shared.bad")))
            .finally(drop);
        }}
      >
        <label className="label" htmlFor="plan-url">
          {t("shared.url")}
        </label>
        <input
          id="plan-url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Button htmlType="submit" shape="round" type="primary" disabled={busy}>
          {t("shared.open")}
        </Button>
      </form>
      {note ? <p className="body">{note}</p> : null}
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
