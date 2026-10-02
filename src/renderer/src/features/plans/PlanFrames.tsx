import { PlanProgress } from "./PlanProgress";
import { SegmentedTabs } from "../../components/SegmentedTabs";
import { StepLines } from "../../components/StepLines";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, Modal } from "antd";
import { MarkdownView } from "../../components/MarkdownView";
import { openSourceViewer } from "../../components/SourceViewer";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { CanvasLayout, FocusLayout } from "../../app/layouts/TaskLayouts";
import { BuildingMark } from "../../components/BuildingMark";
import { invoke } from "../../lib/ipc";
import { examInstant, planFileSchema } from "@shared/plan-file";

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
  const [language, setLanguage] = useState(
    i18n.language.startsWith("en") ? "en" : "it",
  );
  const [style, setStyle] = useState<"read" | "practice" | "decide">("decide");
  const [starting, setStarting] = useState(false);
  const [params, setParams] = useSearchParams();
  const buildPlanId = params.get("build");
  const build = useQuery({
    queryKey: ["plan-build", buildPlanId],
    queryFn: () => invoke("plans.build", { planId: buildPlanId! }),
    enabled: Boolean(buildPlanId),
    refetchInterval: 500,
  });
  const buildingPlan = useQuery({
    queryKey: ["plan", buildPlanId],
    queryFn: () => invoke("plans.read", { planId: buildPlanId! }),
    enabled: Boolean(buildPlanId),
  });
  const busy =
    starting ||
    Boolean(
      buildPlanId &&
      (build.isPending ||
        Boolean(
          build.data && ["running", "queued"].includes(build.data.state),
        )),
    );
  const built = build.data?.state === "succeeded" ? buildPlanId : null;
  const failed = Boolean(
    build.data &&
    ["failed", "cancelled", "interrupted"].includes(build.data.state),
  );
  const [topicTitles, setTopicTitles] = useState<Record<string, string>>({});
  const [startError, setStartError] = useState<string | null>(null);

  async function create() {
    const name = title.trim();
    if (!name || busy) return;
    setStarting(true);
    try {
      const days =
        examChoice === "1"
          ? 1
          : examChoice === "2"
            ? 2
            : examChoice === "3"
              ? 3
              : 10;
      const fromDate = date
        ? new Date(`${date}T12:00:00`).getTime()
        : examInstant(days);
      const result = await invoke("plans.create", {
        title: name,
        subject: subject.trim() || undefined,
        sourceIds: picked,
        examAt: Number.isFinite(fromDate) ? fromDate : null,
        target: target / 100,
        language: language === "en" ? "en" : "it",
        style,
        topicTitles: picked.map(
          (id) =>
            topicTitles[id] ||
            (sources.data ?? []).find((source) => source.id === id)?.title ||
            "",
        ),
      });
      if (!result) return;
      await client.invalidateQueries({ queryKey: ["plans"] });
      setParams({ build: result.planId });
    } catch (err) {
      const key =
        err && typeof err === "object" && "messageKey" in err
          ? String((err as { messageKey: unknown }).messageKey)
          : "";
      if (key !== "errors.aborted") setStartError(key || "wizard.failed");
    } finally {
      setStarting(false);
    }
  }

  if (buildPlanId || busy || built || failed) {
    const name = buildingPlan.data?.title ?? title.trim();
    return (
      <FocusLayout
        title={t("wizard.preparing", { title: name })}
        closable={!busy}
      >
        <BuildingMark
          inner={Math.min(1, (build.data?.progress ?? 0) * 6)}
          middle={Math.max(0, Math.min(1, (build.data?.progress ?? 0) * 6 - 1))}
          outer={Math.max(
            0,
            Math.min(1, ((build.data?.progress ?? 0) * 6 - 2) / 4),
          )}
          done={Boolean(built)}
          failedTrail={failed ? 0 : undefined}
        />
        <p className="title-2">{t("wizard.preparing", { title: name })}</p>
        <StepLines
          steps={(build.data?.steps ?? []).map((step) => ({
            id: step.name,
            label: t(step.label),
            state: step.state === "succeeded" ? "done" : step.state,
          }))}
          label={t("wizard.preparing", { title: name })}
        />
        {build.data?.stepLabel ? (
          <p className="small" role="status">
            {t(build.data.stepLabel)}
          </p>
        ) : null}
        {buildPlanId && !build.isPending && !build.data ? (
          <p className="small" role="alert">
            {t("wizard.buildMissing")}
          </p>
        ) : null}
        {failed ? (
          <p className="small">
            {t(
              build.data?.state === "cancelled"
                ? "wizard.cancelled"
                : "wizard.failed",
            )}
          </p>
        ) : null}
        {built ? (
          <Button
            type="primary"
            shape="round"
            onClick={() => navigate(`/plans/${built}`)}
          >
            {t("wizard.open")}
          </Button>
        ) : null}
        {failed ? (
          <Button
            shape="round"
            onClick={() => {
              if (build.data)
                void invoke(
                  build.data.state === "interrupted"
                    ? "jobs.resume"
                    : "jobs.retry",
                  { jobId: build.data.jobId },
                ).then(() => build.refetch());
            }}
          >
            {t(
              build.data?.state === "interrupted"
                ? "jobs.resume"
                : "wizard.retry",
            )}
          </Button>
        ) : null}
        {busy ? (
          <Button
            shape="round"
            onClick={() => {
              if (build.data)
                void invoke("jobs.cancel", { jobId: build.data.jobId });
            }}
          >
            {t("wizard.cancel")}
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
      {startError ? (
        <p className="small" role="alert">
          {t(startError)}
        </p>
      ) : null}
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
            className={
              picked.includes(source.id) ? "choice is-selected" : "choice"
            }
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
      {picked.length === 0 ? (
        <p className="small">{t("wizard.noMaterial")}</p>
      ) : null}
      {picked.map((id) => {
        const source = (sources.data ?? []).find((item) => item.id === id);
        return (
          <label key={id} className="engine-key">
            <span className="small">{t("wizard.topicName")}</span>
            <input
              aria-label={t("wizard.topicName")}
              value={topicTitles[id] ?? source?.title ?? ""}
              onChange={(event) =>
                setTopicTitles((current) => ({
                  ...current,
                  [id]: event.target.value,
                }))
              }
            />
          </label>
        );
      })}
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
            className={
              !date && examChoice === id ? "choice is-selected" : "choice"
            }
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
        disabled={busy || title.trim() === ""}
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
  const recommended = useQuery({
    queryKey: ["recommend", planId],
    enabled: Boolean(planId),
    queryFn: () => invoke("plans.recommend", { planId: planId ?? "" }),
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
    refetchOnMount: "always",
  });
  const [introOpen, setIntroOpen] = useState(false);
  const intro = useQuery({
    queryKey: ["plan", planId, "intro"],
    queryFn: () => invoke("plans.intro", { planId: planId! }),
    enabled: Boolean(planId),
  });
  const progress = series.data;
  const [tab, setTab] = useState<"progress" | "path" | "topics" | "sources">(
    "progress",
  );
  const [withProgress, setWithProgress] = useState(false);
  const [withSources, setWithSources] = useState(false);
  if (plan.data?.status === "building")
    return (
      <FocusLayout title={plan.data.title} closable>
        <p className="body">{t("wizard.buildInProgress")}</p>
        <Button
          type="primary"
          onClick={() => navigate(`/plans/new?build=${planId}`)}
        >
          {t("wizard.continueBuild")}
        </Button>
      </FocusLayout>
    );
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
            void invoke("plans.export", {
              planId,
              progress: withProgress,
              embed: withSources,
            }).then((file) => {
              const blob = new Blob([JSON.stringify(file)], {
                type: "application/json",
              });
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
      <Modal
        open={introOpen}
        title={t("plans.intro")}
        onCancel={() => setIntroOpen(false)}
        footer={
          <Button
            type="primary"
            onClick={() => {
              const node = plan.data?.nodes.find(
                (item) => item.kind === "intro",
              );
              if (node && planId)
                void invoke("plans.complete", { planId, nodeId: node.id }).then(
                  () => {
                    setIntroOpen(false);
                    void client.invalidateQueries({
                      queryKey: ["plan", planId],
                    });
                    void client.invalidateQueries({
                      queryKey: ["recommend", planId],
                    });
                  },
                );
            }}
          >
            {t("wizard.continue")}
          </Button>
        }
      >
        <MarkdownView
          onCitationClick={(number) => {
            const passageId = intro.data?.passageIds[number - 1];
            if (passageId) openSourceViewer({ passageId });
          }}
        >
          {intro.data?.markdown ?? ""}
        </MarkdownView>
      </Modal>
      {plan.data?.status === "building" ? (
        <Button onClick={() => navigate(`/plans/new?build=${planId}`)}>
          {t("wizard.continueBuild")}
        </Button>
      ) : null}
      {plan.data?.status === "draft" ? (
        <p className="small">{t("plans.draft")}</p>
      ) : null}
      <div className="px-plan-export-options">
        <Checkbox
          checked={withProgress}
          onChange={(event) => setWithProgress(event.target.checked)}
        >
          {t("plans.includeProgress")}
        </Checkbox>
        <Checkbox
          checked={withSources}
          onChange={(event) => setWithSources(event.target.checked)}
        >
          {t("plans.embedSources")}
        </Checkbox>
      </div>
      {withSources ? <p className="small">{t("plans.embedWarning")}</p> : null}
      <SegmentedTabs
        label={t("plans.views")}
        value={tab}
        onChange={(value) => setTab(value as typeof tab)}
        items={[
          { value: "progress", label: t("progress.title") },
          { value: "path", label: t("plans.tabPath") },
          { value: "topics", label: t("plans.tabTopics") },
          { value: "sources", label: t("plans.tabSources") },
        ]}
      />
      {tab === "topics" ? (
        <ul className="choice-list">
          {(plan.data?.topics ?? []).map((topic) => (
            <li key={topic.id} className="small">
              <details>
                <summary>{topic.title}</summary>
                {topic.summary ? <p className="body">{topic.summary}</p> : null}
                <ul>
                  {topic.subtopics.map((name, i) => (
                    <li key={i}>{name}</li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      ) : null}
      {tab === "sources" ? (
        <div>
          <ul className="choice-list">
            {(plan.data?.sources ?? []).map((source) => (
              <li key={source.id} className="small">
                {source.title}
              </li>
            ))}
          </ul>
          <Button
            shape="round"
            onClick={() => {
              if (!planId) return;
              void window.pyxis
                .showOpenDialog({ properties: ["openFile", "multiSelections"] })
                .then(async (paths) => {
                  if (!paths || paths.length === 0) return;
                  const imported = [];
                  for (const path of paths) {
                    imported.push(await invoke("sources.import", { path }));
                  }
                  await invoke("plans.rebuild", {
                    planId,
                    sourceIds: imported.map((item) => item.sourceId),
                  });
                  void client.invalidateQueries({ queryKey: ["plan", planId] });
                });
            }}
          >
            {t("plans.rebuild")}
          </Button>
        </div>
      ) : null}
      {tab === "progress" && progress && (
        <PlanProgress
          planId={planId!}
          progress={progress}
          simulations={simulations.data ?? []}
        />
      )}
      {tab === "path" ? (
        <ol className="choice-list">
          {(plan.data?.nodes ?? []).map((node) => (
            <li key={node.id}>
              <button
                type="button"
                className="choice"
                disabled={node.state === "locked"}
                onClick={() => {
                  if (!planId) return;
                  if (node.kind === "intro" && intro.data) {
                    setIntroOpen(true);
                    return;
                  }
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
                  void invoke("plans.complete", {
                    planId,
                    nodeId: node.id,
                  }).then(() => {
                    void client.invalidateQueries({
                      queryKey: ["plan", planId],
                    });
                    void client.invalidateQueries({
                      queryKey: ["mastery", planId],
                    });
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
      ) : null}
      {recommended.data ? (
        <Button
          type="primary"
          shape="round"
          onClick={() => {
            const node = plan.data?.nodes.find(
              (item) => item.id === recommended.data?.nodeId,
            );
            if (!node || !planId) return;
            if (node.kind === "intro" && intro.data) {
              setIntroOpen(true);
              return;
            }
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
            void invoke("plans.complete", { planId, nodeId: node.id }).then(
              () => {
                void client.invalidateQueries({ queryKey: ["plan", planId] });
                void client.invalidateQueries({
                  queryKey: ["recommend", planId],
                });
              },
            );
          }}
        >
          {t("plans.recommended")}
          {" · "}
          {t(
            recommended.data.reason === "due"
              ? "plans.recommendDue"
              : recommended.data.reason === "gaps"
                ? "plans.recommendGaps"
                : "plans.recommendNext",
            { count: recommended.data.count },
          )}
        </Button>
      ) : null}
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
      <Button
        shape="round"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
      >
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
