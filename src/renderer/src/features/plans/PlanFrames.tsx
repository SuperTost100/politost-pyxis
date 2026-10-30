import { StepLines, type StepLineState } from "../../components/StepLines";
import { Stepper } from "../../components/Stepper";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import "./PlanPage.css";
import { Button, Input, Progress } from "antd";
import "./PlanWizard.css";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { ErrorState } from "../../components/ErrorState";
import { Icon } from "../../components/Icon";
import { Notice } from "../../components/Notice";
import { useEngineError } from "../../lib/engineError";
import { invoke } from "../../lib/ipc";
import { useGradeScale } from "../../lib/useGradeScale";
import { jobErrorEngine, jobErrorKey } from "../jobs/jobErrors";
import type { PlanFile } from "@shared/plan-file";
import { useMenuLock } from "../../app/menu-state";
import { ImportReview } from "./ImportReview";
import { readPlanText, type ImportRequest } from "./importPreview";
import { takePlanText } from "./openedPlan";
import { isWizardSeed } from "./wizardSeed";
import { ExamStep, MaterialPrimary, MaterialStep, useExamDraft } from "./ExamDraft";
import { usePlan } from "../../lib/queries";

/** The new exam wizard: the exam on one screen, its material on the next. With `?build=` it is the wait screen. */
export function WizardFrame() {
  const [params] = useSearchParams();
  const buildPlanId = params.get("build");
  return buildPlanId ? <BuildScreen planId={buildPlanId} /> : <Wizard />;
}

function Wizard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { scale } = useGradeScale();
  // Back from the guided flow returns here with the answers already given.
  const location = useLocation();
  const back =
    (location.state as {
      wizard?: unknown;
      step?: number;
      books?: boolean;
    } | null) ?? {};
  const seed = isWizardSeed(back.wizard) ? back.wizard : null;
  const [step, setStep] = useState(seed ? Math.min(back.step ?? 1, 1) : 0);
  // "Start from a free PoliTost book" opens the wizard with the books already showing.
  const draft = useExamDraft({ seed, books: back.books === true, scale });
  const [, setParams] = useSearchParams();
  // Answers given so far live only on this page, so the menu leaves it alone until it has some.
  useMenuLock(
    step > 0 || draft.starting || draft.title.trim() !== "" || draft.picked.length > 0,
  );
  // An error belongs to the step and the attempt that raised it.
  function goTo(next: number) {
    draft.setStartError(null);
    setStep(next);
  }
  return (
    <FocusLayout
      title={t("wizard.title")}
      progress={(step + 1) / 2}
      secondary={
        <Button
          type="text"
          shape="round"
          onClick={() => (step === 0 ? navigate("/exams") : goTo(0))}
        >
          {t("nav.back")}
        </Button>
      }
      primary={
        step === 0 ? (
          <Button
            type="primary"
            shape="round"
            disabled={!draft.examReady}
            aria-describedby={!draft.title.trim() ? "wizard-title-required" : undefined}
            onClick={() => goTo(1)}
          >
            {t("wizard.continue")}
          </Button>
        ) : (
          <MaterialPrimary
            draft={draft}
            onCreated={(planId) => setParams({ build: planId })}
          />
        )
      }
    >
      <div className="px-plan-wizard">
        <Stepper current={step} steps={[t("wizard.examStep"), t("wizard.material")]} />
        <h2 className="title-1 px-wizard-question">{t(`wizard.questions.${step}`)}</h2>
        {draft.startError ? (
          <p className="small" role="alert">
            {t(draft.startError)}
          </p>
        ) : null}
        {step === 0 ? (
          <>
            <ExamStep draft={draft} />
            {!draft.title.trim() ? (
              <p id="wizard-title-required" className="small ink-muted">
                {t("wizard.titleRequired")}
              </p>
            ) : null}
          </>
        ) : (
          <MaterialStep draft={draft} />
        )}
      </div>
    </FocusLayout>
  );
}

const SETTLED = ["succeeded", "failed", "cancelled", "interrupted"];

/**
 * The wait while an exam is prepared: the build's steps as the job reports them, its overall progress, and the topics
 * as soon as the path step has written them. The build runs in core, so closing the screen leaves it running.
 */
function BuildScreen({ planId }: { planId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const build = useQuery({
    queryKey: ["plan-build", planId],
    queryFn: () => invoke("plans.build", { planId }),
    // Follows the job until it settles; Retry and Resume refetch by hand and bring the interval back. A missing build
    // (null) is final too: the screen says so and there is nothing to follow.
    refetchInterval: (query) =>
      query.state.data === null || SETTLED.includes(query.state.data?.state ?? "") ? false : 500,
  });
  const plan = usePlan(planId);
  const busy =
    build.isPending ||
    Boolean(build.data && ["running", "queued"].includes(build.data.state));
  const built = build.data?.state === "succeeded";
  const failed = Boolean(
    build.data && ["failed", "cancelled", "interrupted"].includes(build.data.state),
  );
  // A build that stopped on a refused sign-in names the engine and offers its sign-in.
  const describeEngineError = useEngineError();
  const buildError = build.data?.error;
  const buildFailure = buildError
    ? describeEngineError(jobErrorKey(buildError), jobErrorEngine(buildError))
    : undefined;
  // The plan's topics exist once the path step has run. Each step that ends reads the plan again, so they appear then.
  const settledSteps = (build.data?.steps ?? [])
    .filter((step) => step.state === "succeeded")
    .map((step) => step.name)
    .join();
  const refetchPlan = useRef(plan.refetch);
  refetchPlan.current = plan.refetch;
  useEffect(() => {
    if (settledSteps) void refetchPlan.current();
  }, [settledSteps]);
  const name = plan.data?.title ?? "";
  const topics = plan.data?.topics ?? [];
  const retryAction = {
    label: t(build.data?.state === "interrupted" ? "jobs.resume" : "wizard.retry"),
    onClick: () => {
      if (build.data)
        void invoke(build.data.state === "interrupted" ? "jobs.resume" : "jobs.retry", {
          jobId: build.data.jobId,
        }).then(() => build.refetch());
    },
  };
  const heading = failed
    ? t(build.data?.state === "cancelled" ? "wizard.cancelledTitle" : "wizard.preparingFailed")
    : name
      ? t(built ? "wizard.ready" : "wizard.preparing", { title: name })
      : t("wizard.waitTitle");
  const percent = Math.round((build.data?.progress ?? 0) * 100);
  return (
    <FocusLayout
      title={t("wizard.waitTitle")}
      headerRight={
        busy ? (
          <Button
            type="text"
            shape="round"
            onClick={() => {
              if (build.data) void invoke("jobs.cancel", { jobId: build.data.jobId });
            }}
          >
            {t("wizard.cancel")}
          </Button>
        ) : null
      }
      primary={
        built ? (
          <Button
            type="primary"
            shape="round"
            size="large"
            // The one thing left to do once the exam is ready, so Enter opens it.
            autoFocus
            onClick={() => navigate(`/plans/${planId}`)}
          >
            {t("wizard.open")}
          </Button>
        ) : null
      }
    >
      <div className="px-build">
        <header className="px-build-head">
          <h2 className="title-1">{heading}</h2>
          {busy ? <p className="body ink-muted">{t("wizard.waitBody")}</p> : null}
        </header>
        <div className={topics.length ? "px-build-grid has-topics" : "px-build-grid"}>
          <div className="px-build-steps">
            <StepLines
              steps={(build.data?.steps ?? []).map((step) => ({
                id: step.name,
                // A step that failed is told in the past tense.
                label:
                  step.state === "failed"
                    ? t(`${step.label}Failed`, { defaultValue: t(step.label) })
                    : t(step.label),
                state: (step.state === "succeeded" ? "done" : step.state) as StepLineState,
              }))}
              label={heading}
            />
            {busy && build.data ? (
              <>
                <Progress
                  className="px-build-progress"
                  percent={percent}
                  showInfo={false}
                  aria-label={t("wizard.buildProgress", { percent })}
                />
                <p className="small px-build-status" role="status">
                  {t("wizard.buildProgress", { percent })}
                </p>
              </>
            ) : null}
          </div>
          {topics.length ? (
            <section className="px-build-topics" aria-labelledby="px-build-topics">
              <h3 id="px-build-topics" className="label">
                {t("wizard.topicsFound", { count: topics.length })}
              </h3>
              <ol className="px-build-topic-list">
                {topics.map((topic, index) => (
                  <li key={topic.id}>
                    <span className="meta px-build-topic-n" aria-hidden>
                      {index + 1}
                    </span>
                    <span className="small">{topic.title}</span>
                    <Icon name="check" size={16} />
                  </li>
                ))}
              </ol>
              <p className="small ink-muted">{t("wizard.topicsFoundNote")}</p>
            </section>
          ) : null}
        </div>
        {!build.isPending && !build.data ? (
          <div className="px-build-notice">
            <ErrorState action={{ label: t("nav.toExams"), onClick: () => navigate("/exams") }}>
              {t("wizard.buildMissing")}
            </ErrorState>
          </div>
        ) : null}
        {failed ? (
          <div className="px-build-notice">
            {build.data?.state === "cancelled" ? (
              <Notice tone="warning" action={retryAction}>
                {t("wizard.cancelled")}
              </Notice>
            ) : (
              <ErrorState
                action={retryAction}
                secondary={buildFailure?.action}
                details={build.data?.error}
              >
                {buildFailure?.action
                  ? `${t("wizard.buildFailed")} ${buildFailure.text}`
                  : t("wizard.buildFailed")}
              </ErrorState>
            )}
          </div>
        ) : null}
      </div>
    </FocusLayout>
  );
}

export { PlanPage } from "./PlanOverview";
export { ExamSettingsPage } from "./ExamSettings";
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
    const read = readPlanText(text);
    setReview("file" in read ? read.file : null);
    setNote("file" in read ? null : t(`shared.reason.${read.reason}`));
  }

  // A file opened from the system or dropped on the window waits in the store. It is taken when this page mounts, and
  // again whenever the page is entered again (a new location key), so a page that is on its way out never claims it.
  const location = useLocation();
  const openWaiting = useRef((text: string) => openText(text));
  openWaiting.current = openText;
  useEffect(() => {
    const text = takePlanText();
    if (text !== null) openWaiting.current(text);
  }, [location.key]);

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
            placeholder={t("shared.urlPlaceholder")}
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
