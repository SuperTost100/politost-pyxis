import { SegmentedTabs } from "../../components/SegmentedTabs";
import { StepLines } from "../../components/StepLines";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import "./PlanPage.css";
import { Button, Input, Modal, Steps, DatePicker, Slider } from "antd";
import dayjs from "dayjs";
import dateIt from "antd/es/date-picker/locale/it_IT";
import dateEn from "antd/es/date-picker/locale/en_GB";
import { WizardSources } from "./WizardSources";
import "./PlanWizard.css";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { CanvasLayout, FocusLayout } from "../../app/layouts/TaskLayouts";
import { BuildingMark } from "../../components/BuildingMark";
import { invoke } from "../../lib/ipc";
import { examInstant, type PlanFile } from "@shared/plan-file";
import { ImportReview } from "./ImportReview";
import { parsePlanText, type ImportRequest } from "./importPreview";
import { isWizardSeed, type WizardSeed } from "./wizardSeed";

export function WizardFrame() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const sources = useQuery({
    queryKey: ["sources"],
    queryFn: () => invoke("sources.list", {}),
    // A source just imported is still being read. Its status follows until it settles.
    refetchInterval: (query) =>
      query.state.data?.some((source) =>
        ["queued", "extracting", "indexing", "ocr-queued"].includes(
          source.status,
        ),
      )
        ? 1000
        : false,
  });
  const subjects = useQuery({
    queryKey: ["subjects"],
    queryFn: () => invoke("subjects.list", {}),
  });
  // Back from the guided flow returns here with the answers already given.
  const location = useLocation();
  const back = (location.state as { wizard?: unknown; step?: number } | null) ?? {};
  const seed = isWizardSeed(back.wizard) ? back.wizard : null;
  const [wizardStep, setWizardStep] = useState(seed ? (back.step ?? 3) : 0);
  const [title, setTitle] = useState(seed?.title ?? "");
  const [subject, setSubject] = useState(seed?.subject ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  const [examChoice, setExamChoice] = useState<"1" | "2" | "3" | "10">(
    seed?.examChoice ?? "10",
  );
  const [date, setDate] = useState(seed?.date ?? "");
  const [target, setTarget] = useState(seed?.target ?? 75);
  const [language, setLanguage] = useState(
    seed?.language ?? (i18n.language.startsWith("en") ? "en" : "it"),
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

  // PLAN-10: no material leads to the guided flow, which asks its own questions.
  function startGuided() {
    const answers: WizardSeed = {
      title: title.trim(),
      subject,
      examChoice,
      date,
      target,
      language: language === "en" ? "en" : "it",
    };
    navigate("/plans/new/guided", { state: answers });
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

  const stepNames = [
    t("wizard.subject"),
    t("wizard.exam"),
    t("wizard.targetStep"),
    t("wizard.material"),
    t("wizard.language"),
    t("wizard.style"),
  ];
  const chosenSources = (sources.data ?? []).filter((source) =>
    picked.includes(source.id),
  );
  const blockedSource = chosenSources.some((source) =>
    ["failed", "needs-ocr", "cancelled", "interrupted"].includes(source.status),
  );
  const disabledReason = !title.trim()
    ? t("wizard.titleRequired")
    : blockedSource
      ? t("wizard.sourceNotReady")
      : null;
  const examAt = date
    ? dayjs(date).hour(12).valueOf()
    : examInstant(Number(examChoice));
  return (
    <FocusLayout
      title={t("wizard.title")}
      progress={(wizardStep + 1) / 6}
      secondary={
        <Button
          type="text"
          shape="round"
          onClick={() =>
            wizardStep === 0
              ? navigate("/exams")
              : setWizardStep(wizardStep - 1)
          }
        >
          {t("nav.back")}
        </Button>
      }
      primary={
        wizardStep < 5 ? (
          <Button
            type="primary"
            shape="round"
            disabled={wizardStep === 0 && !title.trim()}
            onClick={() =>
              wizardStep === 3 && picked.length === 0
                ? startGuided()
                : setWizardStep(wizardStep + 1)
            }
          >
            {t("wizard.continue")}
          </Button>
        ) : (
          <Button
            className="px-wizard-create"
            type="primary"
            shape="round"
            disabled={busy || !!disabledReason}
            aria-describedby={
              disabledReason ? "wizard-create-reason" : undefined
            }
            onClick={() => void create()}
          >
            {t("wizard.create")}
          </Button>
        )
      }
    >
      <div className="px-plan-wizard">
        <Steps
          size="small"
          current={wizardStep}
          items={stepNames.map((title) => ({ title }))}
        />
        <h2 className="title-1 px-wizard-question">
          {t(`wizard.questions.${wizardStep}`)}
        </h2>
        {startError ? (
          <p className="small" role="alert">
            {t(startError)}
          </p>
        ) : null}
        {wizardStep === 0 ? (
          <>
            <div className="px-form-field">
              <label className="label" htmlFor="plan-title">
                {t("wizard.planTitle")}
              </label>
              <Input
                id="plan-title"
                maxLength={500}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="px-form-field">
              <label className="label" htmlFor="plan-subject">
                {t("wizard.subject")}
              </label>
              <Input
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
            </div>
            <div className="px-wizard-subjects">
              {(subjects.data ?? []).map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={
                    subject === item.name ? "choice is-selected" : "choice"
                  }
                  aria-pressed={subject === item.name}
                  onClick={() => {
                    setSubject(item.name);
                    if (!title.trim()) setTitle(item.name);
                  }}
                >
                  {item.name}
                </button>
              ))}
            </div>
            <Button
              shape="round"
              disabled={
                !subject.trim() ||
                (subjects.data ?? []).some(
                  (item) => item.name === subject.trim(),
                )
              }
              onClick={() => {
                void invoke("subjects.add", { name: subject.trim() })
                  .then(() =>
                    client.invalidateQueries({ queryKey: ["subjects"] }),
                  )
                  .catch(() => setStartError("wizard.failed"));
              }}
            >
              {t("wizard.addSubject")}
            </Button>
            {!title.trim() ? (
              <p className="small ink-muted">{t("wizard.titleRequired")}</p>
            ) : null}
          </>
        ) : null}
        {wizardStep === 1 ? (
          <>
            <div className="choice-list">
              {(
                [
                  ["1", t("wizard.tomorrow")],
                  ["3", t("wizard.inTwoOrThree")],
                  ["10", t("wizard.inTen")],
                ] as const
              ).map(([id, label]) => (
                <button
                  type="button"
                  key={id}
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
            <div className="px-form-field">
              <label className="label" htmlFor="plan-date">
                {t("wizard.examDate")}
              </label>
              <DatePicker
                id="plan-date"
                value={date ? dayjs(date) : null}
                locale={i18n.language.startsWith("it") ? dateIt : dateEn}
                format="DD/MM/YYYY"
                disabledDate={(value) =>
                  value.startOf("day").isBefore(dayjs().startOf("day"))
                }
                onChange={(value) =>
                  setDate(value ? value.format("YYYY-MM-DD") : "")
                }
              />
            </div>
            <p className="body ink-muted">
              {t("wizard.examSummary", {
                date: new Intl.DateTimeFormat(i18n.language, {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                }).format(examAt),
              })}
            </p>
          </>
        ) : null}
        {wizardStep === 2 ? (
          <>
            <div className="px-wizard-target-value stat" aria-live="polite">
              {target}
              <span className="body">/ 100</span>
            </div>
            <label className="label" htmlFor="plan-target">
              {t("wizard.target", { score: target })}
            </label>
            <Slider
              id="plan-target"
              className="px-wizard-gold-slider"
              min={50}
              max={100}
              step={5}
              value={target}
              onChange={setTarget}
              ariaLabelForHandle={t("wizard.target", { score: target })}
              tooltip={{ open: false }}
              marks={{ 60: "60", 75: "75", 90: "90" }}
            />
            <div className="px-wizard-target-guide">
              {[60, 75, 90].map((score) => (
                <p key={score} className="small">
                  <strong>{score}</strong>
                  <span>{t(`wizard.targetGuide.${score}`)}</span>
                </p>
              ))}
            </div>
          </>
        ) : null}
        {wizardStep === 3 ? (
          <WizardSources
            library={sources.data ?? []}
            picked={picked}
            onPick={(ids) =>
              setPicked((current) => [
                ...current,
                ...ids.filter((id) => !current.includes(id)),
              ])
            }
            onRemove={(id) =>
              setPicked((current) => current.filter((item) => item !== id))
            }
            onGuided={startGuided}
            blocked={blockedSource}
          />
        ) : null}
        {wizardStep === 4 ? (
          <>
            <div className="choice-list">
              {(
                [
                  ["it", t("wizard.italian")],
                  ["en", t("wizard.english")],
                ] as const
              ).map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  className={language === id ? "choice is-selected" : "choice"}
                  aria-pressed={language === id}
                  onClick={() => setLanguage(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="small ink-muted">{t("wizard.languageLocked")}</p>
          </>
        ) : null}
        {wizardStep === 5 ? (
          <>
            <div className="choice-list">
              {(
                [
                  ["read", t("wizard.read")],
                  ["practice", t("wizard.practice")],
                  ["decide", t("wizard.decide")],
                ] as const
              ).map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  className={style === id ? "choice is-selected" : "choice"}
                  aria-pressed={style === id}
                  onClick={() => setStyle(id)}
                >
                  <span className="body-strong">{label}</span>
                  <span className="small">{t(`wizard.styleHelp.${id}`)}</span>
                </button>
              ))}
            </div>
            <div className="px-wizard-summary">
              <p className="body-strong">{title}</p>
              <p className="small ink-muted">
                {t("wizard.sourcesInPlan", { count: chosenSources.length })} ·{" "}
                {t("wizard.target", { score: target })}
              </p>
            </div>
            {disabledReason ? (
              <p id="wizard-create-reason" className="small" role="status">
                {disabledReason}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </FocusLayout>
  );
}

export { PlanPage } from "./PlanOverview";
export { GuidedPlanPage } from "./GuidedPlan";

export function SharedPlanPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [url, setUrl] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<PlanFile | null>(null);
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

  // The file is only validated here; nothing is written until the person confirms the summary.
  function openText(text: string) {
    const parsed = parsePlanText(text);
    setReview(parsed);
    setNote(parsed ? null : t("shared.bad"));
  }

  async function importReviewed(request: ImportRequest) {
    const result = await invoke("plans.import", request);
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
        accept="application/json,.json,.pyxis"
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
        className="px-shared-form"
        onSubmit={(event) => {
          event.preventDefault();
          const link = url.trim();
          if (!link || !take()) return;
          void window.pyxis
            .fetchPlan(link)
            .then(openText)
            .catch((error: unknown) => {
              const detail = error instanceof Error ? error.message : "";
              setNote(
                t(
                  detail.includes("plan-too-big")
                    ? "shared.tooBig"
                    : detail.includes("plan-redirect")
                      ? "shared.redirectFailed"
                      : detail.includes("link-scheme") ||
                          detail.includes("plan-url")
                        ? "shared.unsafeLink"
                        : "shared.downloadFailed",
                ),
              );
            })
            .finally(drop);
        }}
      >
        <label className="label" htmlFor="plan-url">
          {t("shared.url")}
        </label>
        <div className="px-form-inline">
          <Input
            id="plan-url"
            type="url"
            disabled={busy}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <Button
            htmlType="submit"
            shape="round"
            type="primary"
            disabled={busy}
          >
            {t("shared.open")}
          </Button>
        </div>
      </form>
      {note ? <p className="body">{note}</p> : null}
      {review ? (
        <ImportReview
          file={review}
          onImport={importReviewed}
          onCancel={() => setReview(null)}
        />
      ) : null}
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
