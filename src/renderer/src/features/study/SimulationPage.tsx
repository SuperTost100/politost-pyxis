import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Modal } from "antd";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { useMenuLock } from "../../app/menu-state";
import { MathInput } from "../../components/MathInput";
import { MarkdownView } from "../../components/MarkdownView";
import { Notice } from "../../components/Notice";
import { MasteryBar } from "../../components/MasteryBar";
import { StepLines } from "../../components/StepLines";
import { ExportButton } from "../share/ExportButton";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";
import { useDeadlinePassed, useNow } from "./clock";
import { useDraftSaver } from "./draftSaver";
import { ActivityChoice, ActivityIntro } from "./ActivityIntro";
import "./SimulationPage.css";
import { pastPapersQuery, usePlan } from "../../lib/queries";

/** How long typing pauses before the answers are saved. */
const DRAFT_DELAY_MS = 500;

export function SimulationPage() {
  const { t } = useTranslation();
  const { planId = "", attemptId } = useParams();
  useActiveTime(planId, null);
  const navigate = useNavigate();
  const client = useQueryClient();
  // The attempt in the address; starting one or finding one running navigates there.
  const started = attemptId ?? null;
  const [length, setLength] = useState(30);
  const [format, setFormat] = useState<"past" | "generic">("past");
  const [source, setSource] = useState<"exam" | "mixed">("exam");
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [noEngine, setNoEngine] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // Typing saves at most every DRAFT_DELAY_MS; time-up, submit and leaving the page save at once.
  const drafts = useDraftSaver(
    (draft: { attemptId: string; picks: Record<string, string> }) =>
      invoke("study.simulationDraft", draft),
    () => setNotice(t("simulation.saveFailed")),
    DRAFT_DELAY_MS,
  );
  const plan = usePlan(planId);
  const open = useQuery({
    queryKey: ["simulation", planId, started],
    enabled: Boolean(planId),
    // A running exam is read every second for the time-up freeze and the grading job. Before an attempt starts,
    // once handed in, or when grading has stopped (Retry invalidates this query), there is nothing left to watch.
    refetchInterval: (query) => {
      const read = query.state.data;
      if (!started || read?.submitted) return false;
      if (
        read?.grading &&
        ["failed", "cancelled", "interrupted"].includes(read.grading.state)
      )
        return false;
      return 1000;
    },
    queryFn: () =>
      started
        ? invoke("study.simulationRead", { attemptId: started })
        : invoke("study.simulationOpen", { planId }),
  });
  const build = useQuery({
    queryKey: ["simulation-build", planId],
    enabled: Boolean(planId) && !started,
    // Follows the build until it settles; Retry and Resume invalidate it and bring the interval back.
    refetchInterval: (query) =>
      ["succeeded", "failed", "cancelled", "interrupted"].includes(
        query.state.data?.state ?? "",
      )
        ? false
        : 1000,
    queryFn: () => invoke("study.simulationBuild", { planId }),
  });
  const building = build.data;
  const papers = useQuery({
    ...pastPapersQuery(planId),
    enabled: Boolean(planId) && !started,
  });
  // The past papers' structure, when the plan has any; the setup offers to copy it.
  const style = papers.data?.style ?? null;
  const matchPast = style != null && format === "past";
  // A finished build is only prepared: no attempt exists and no clock runs until Start.
  const ready = building?.state === "succeeded";
  const buildStopped = ["failed", "cancelled", "interrupted"].includes(
    building?.state ?? "",
  );
  const run = open.data?.planId === planId ? open.data : undefined;
  function startFailed(err: unknown) {
    const text = String((err as { code?: string })?.code ?? err);
    setNotice(
      text.includes("engine-missing")
        ? t("simulation.noEngine")
        : text.includes("simulation-empty")
          ? t("simulation.empty")
          : t("simulation.startFailed"),
    );
    setNoEngine(text.includes("engine-missing"));
  }
  function begin(request: Promise<{ attemptId: string }>) {
    setBusy(true);
    setNotice("");
    setNoEngine(false);
    return request
      .then(async ({ attemptId: next }) => {
        navigate(`/plans/${planId}/exam/${next}`, { replace: true });
        await client.invalidateQueries({
          queryKey: ["simulation-build", planId],
        });
      })
      .catch(startFailed)
      .finally(() => setBusy(false));
  }
  async function control(action: "jobs.cancel" | "jobs.retry" | "jobs.resume") {
    if (!building) return;
    await invoke(action, { jobId: building.jobId }).catch(() =>
      setNotice(t("simulation.actionFailed")),
    );
    await client.invalidateQueries({ queryKey: ["simulation-build", planId] });
  }
  useEffect(() => {
    if (building) {
      setLength(building.minutes);
      setFormat(building.styled ? "past" : "generic");
    }
  }, [building?.jobId, building?.minutes, building?.styled]);
  // Past exams that state a duration set the time limit, until the student picks another.
  useEffect(() => {
    if (style?.minutes && !building) setLength(style.minutes);
  }, [style?.minutes, building == null]);
  useEffect(() => {
    if (run && !started) {
      navigate(`/plans/${planId}/exam/${run.attemptId}`, { replace: true });
    }
  }, [run?.attemptId, started, planId, navigate]);
  useEffect(() => {
    setPicks({});
    setIndex(0);
  }, [run?.attemptId]);
  const timeUp = useDeadlinePassed(run?.deadline, Boolean(run && !run.submitted));
  const locked = Boolean(
    run && (run.submitted || run.grading || run.locked || timeUp),
  );
  // The menu leaves a running simulation alone.
  useMenuLock(Boolean(run) && !locked);
  useEffect(() => {
    if (locked) void drafts.flush();
  }, [locked]);
  // The shell asks core whether an exam is running when it opens and when told; starting, time-up and handing in tell it.
  useEffect(() => {
    void client.invalidateQueries({ queryKey: ["active-simulation"] });
  }, [run?.attemptId, run?.submitted, Boolean(run?.grading), locked]);
  const shown = locked
    ? (run?.picks ?? {})
    : { ...(run?.picks ?? {}), ...picks };
  const question = run?.questions[index];
  const unanswered =
    run?.questions.filter((q) => !(shown[q.id] ?? "").trim()).length ?? 0;
  const provenance = [
    ...new Set(
      run?.results
        ?.filter((r) => r.provider && r.model)
        .map((r) => `${r.provider} · ${r.model}`) ?? [],
    ),
  ].join(", ");
  // A plan file carries that the exam was handed in, not the answers or the grade.
  const noAnswers = Boolean(run?.submitted) && run?.score === undefined && !run?.results?.length;
  async function submit() {
    if (!run || busy) return;
    setConfirm(false);
    setBusy(true);
    setNotice("");
    try {
      await drafts.flush();
      await invoke("study.simulationSubmit", {
        attemptId: run.attemptId,
        picks: shown,
      });
      await client.invalidateQueries({ queryKey: ["simulation", planId] });
    } catch (err) {
      setNotice(
        String((err as { code?: string })?.code ?? err).includes(
          "engine-missing",
        )
          ? t("simulation.noEngine")
          : t("simulation.actionFailed"),
      );
      setNoEngine(
        String((err as { code?: string })?.code ?? err).includes(
          "engine-missing",
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  const generated = run?.generated
    ? t("simulation.generatedWarning", {
        model: `${run.generated.provider} · ${run.generated.model}`,
      })
    : "";
  // The setup's one action: write the questions first when the material has no exam exercises, then start the clock.
  function prepare() {
    setBusy(true);
    setNotice("");
    setNoEngine(false);
    void invoke("study.simulationPrepare", {
      planId,
      minutes: length,
      source,
      ...(style ? { matchPast } : {}),
    })
      .then(async (next) => {
        if (next.attemptId) {
          navigate(`/plans/${planId}/exam/${next.attemptId}`, {
            replace: true,
          });
        } else
          await client.invalidateQueries({
            queryKey: ["simulation-build", planId],
          });
      })
      .catch(startFailed)
      .finally(() => setBusy(false));
  }
  function startNow() {
    void begin(
      invoke("study.simulationStart", {
        planId,
        minutes: building?.minutes ?? length,
        source,
      }),
    );
  }
  const setupLocked = busy || open.isPending || (Boolean(building) && !buildStopped);
  const topicCount = plan.data?.topics.length ?? 0;
  const noticeBox = notice ? (
    <Notice
      tone="danger"
      action={
        noEngine
          ? {
              label: t("simulation.openSettings"),
              onClick: () => navigate("/settings"),
            }
          : undefined
      }
    >
      {notice}
    </Notice>
  ) : null;
  return (
    <FocusLayout
      title={
        run
          ? (plan.data?.title ?? t("simulation.title"))
          : t("simulation.title")
      }
      closable={!run || run.submitted || locked}
      headerRight={
        run && !run.submitted ? (
          <div className="px-sim-header-actions">
            <SimulationClock
              deadline={run.deadline}
              stopped={Boolean(run.locked) || timeUp}
            />
            {!locked && (
              <Button
                shape="round"
                disabled={busy}
                onClick={() => setConfirm(true)}
              >
                {t("simulation.submit")}
              </Button>
            )}
          </div>
        ) : undefined
      }
      secondary={
        run && (run.submitted || locked) ? (
          <Button
            type="text"
            shape="round"
            onClick={() => navigate(`/plans/${planId}`)}
          >
            {t("nav.back")}
          </Button>
        ) : undefined
      }
    >
      {run ? noticeBox : null}
      {run && !run.submitted && run.blocked && !run.grading && (
        <Notice
          tone="warning"
          action={{
            label: t("simulation.openSettings"),
            onClick: () => navigate("/settings"),
          }}
        >
          {t("simulation.noEngineLocked")}
        </Notice>
      )}
      {generated && <Notice tone="warning">{generated}</Notice>}
      {open.isError && (
        <Notice tone="warning">{t("simulation.actionFailed")}</Notice>
      )}
      {!run ? (
        <ActivityIntro
          eyebrow={plan.data?.title ?? t("simulation.title")}
          title={t("plans.path.activity.simulation")}
          sentence={t("simulation.tutorLocked")}
          facts={[
            { icon: "clock", label: t("simulation.minutes", { count: length }) },
            ...(topicCount
              ? [{ icon: "book-open" as const, label: t("quiz.factTopics", { count: topicCount }) }]
              : []),
            { icon: "circle-check", label: t("simulation.factGrading") },
          ]}
          options={
            <>
              <ActivityChoice
                label={t("simulation.duration")}
                value={length}
                disabled={setupLocked}
                // The usual lengths, plus the past exams' duration and whatever the prepared exam uses.
                choices={[
                  ...new Set([30, 60, 90, 120, ...(style?.minutes ? [style.minutes] : []), length]),
                ]
                  .sort((a, b) => a - b)
                  .map((value) => ({
                    value,
                    label: t("simulation.minutes", { count: value }),
                  }))}
                onChange={setLength}
              />
              {style ? (
                <>
                  <ActivityChoice
                    label={t("simulation.format")}
                    value={format}
                    disabled={setupLocked}
                    choices={[
                      { value: "past" as const, label: t("simulation.formatPast") },
                      { value: "generic" as const, label: t("simulation.formatGeneric") },
                    ]}
                    onChange={setFormat}
                  />
                  {format === "past" ? (
                    <p className="small ink-muted px-sim-format-note">
                      {t("simulation.formatPastInfo", {
                        count: style.papers,
                        questions: style.questions,
                      })}
                    </p>
                  ) : null}
                </>
              ) : null}
              <ActivityChoice
                label={t("simulation.material")}
                value={source}
                disabled={setupLocked}
                choices={[
                  { value: "exam", label: t("simulation.exam") },
                  { value: "mixed", label: t("simulation.mixed") },
                ]}
                onChange={setSource}
              />
            </>
          }
          startLabel={t(ready ? "simulation.startNow" : "simulation.start")}
          starting={busy}
          disabled={!ready && (open.isPending || (Boolean(building) && !buildStopped))}
          onStart={ready ? startNow : prepare}
          onBack={() => navigate(`/plans/${planId}`)}
        >
          {noticeBox}
          {ready && (
            <>
              <h3 className="body-strong">{t("simulation.readyTitle")}</h3>
              <Notice tone="info">{t("simulation.readyInfo")}</Notice>
            </>
          )}
          {building && !buildStopped && !ready && (
            <>
              <h3 className="body-strong">{t("simulation.buildTitle")}</h3>
              <Notice tone="info">{t("simulation.buildInfo")}</Notice>
              <StepLines
                label={t("simulation.building")}
                steps={[
                  {
                    id: building.jobId,
                    label: `${t("simulation.building")} · ${Math.round(building.progress * 100)}%`,
                    state: "running",
                  },
                ]}
              />
              <Button
                shape="round"
                className="px-sim-build-cancel"
                onClick={() => void control("jobs.cancel")}
              >
                {t("simulation.buildCancel")}
              </Button>
            </>
          )}
          {building && buildStopped && (
            <Notice
              tone="danger"
              action={{
                label: t("simulation.buildRetry"),
                onClick: () =>
                  void control(
                    building.state === "interrupted"
                      ? "jobs.resume"
                      : "jobs.retry",
                  ),
              }}
            >
              {t("simulation.buildFailed")}
            </Notice>
          )}
        </ActivityIntro>
      ) : run.submitted ? (
        <section className="px-sim-results">
          {run.score !== undefined && (
            <div className="px-sim-score">
              <span className="stat">{Math.round(run.score * 100)}</span>
              <span className="small">{t("simulation.outOf100")}</span>
            </div>
          )}
          {noAnswers ? (
            <Notice tone="info">{t("quiz.answersNotShared")}</Notice>
          ) : (
            <Notice tone="info">
              {provenance
                ? t("simulation.modelGrade", { model: provenance })
                : t("simulation.localGrade")}
            </Notice>
          )}
          {noAnswers ? null : (
            <>
              <h2 className="title-2">{t("simulation.byTopic")}</h2>
              <ul className="px-sim-topics">
                {run.topics.map((topic) => (
                  <li key={topic.id}>
                    <span className="body-strong">{topic.title}</span>
                    <MasteryBar
                      value={Math.round(topic.score * 100)}
                      label={topic.title}
                    />
                  </li>
                ))}
              </ul>
              {run.questions.map((q, i) => {
                const result = run.results?.find((r) => r.id === q.id);
                return (
                  <details className="px-sim-feedback" key={q.id}>
                    <summary className="body-strong">
                      {t("simulation.question", { count: i + 1 })}
                      {result && (
                        <span className="code">
                          {Math.round(result.score * 100)} / 100
                        </span>
                      )}
                    </summary>
                    <MarkdownView>{q.stem}</MarkdownView>
                    <h3 className="body-strong">{t("quiz.yourAnswer")}</h3>
                    <MarkdownView>
                      {shown[q.id] || t("simulation.blank")}
                    </MarkdownView>
                    {result && (
                      <>
                        <MarkdownView>{result.feedback}</MarkdownView>
                        {result.missed.length > 0 && (
                          <>
                            <h3 className="body-strong">
                              {t("simulation.missed")}
                            </h3>
                            <ul>
                              {result.missed.map((text, j) => (
                                <li key={j}>
                                  <MarkdownView variant="body">{text}</MarkdownView>
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                        <h3 className="body-strong">{t("simulation.reference")}</h3>
                        <MarkdownView>{result.expected}</MarkdownView>
                      </>
                    )}
                  </details>
                );
              })}
            </>
          )}
        </section>
      ) : run.grading ? (
        <section className="px-sim-grading">
          <h2 className="title-2">{t("simulation.grading")}</h2>
          <Notice tone="info">{t("simulation.frozen")}</Notice>
          <StepLines
            label={t("simulation.grading")}
            steps={run.questions.map((q, i) => {
              const complete = Math.floor(
                run.grading!.progress * run.questions.length,
              );
              const failed = ["failed", "cancelled", "interrupted"].includes(
                run.grading!.state,
              );
              return {
                id: q.id,
                label: t("simulation.question", { count: i + 1 }),
                state:
                  i < complete
                    ? "done"
                    : i === complete
                      ? failed
                        ? "failed"
                        : "running"
                      : "pending",
              };
            })}
          />
          {["failed", "cancelled", "interrupted"].includes(
            run.grading.state,
          ) && (
            <Notice
              tone="danger"
              details={run.grading.error?.slice(0, 2000)}
              action={{
                label: t("simulation.retryGrade"),
                onClick: () => void submit(),
              }}
            >
              {t("simulation.gradeFailed")}
            </Notice>
          )}
        </section>
      ) : (
        <section className="px-sim-run">
          <nav
            className="px-sim-questions"
            aria-label={t("simulation.navigate")}
          >
            {run.questions.map((q, i) => (
              <button
                type="button"
                className={`px-sim-question${shown[q.id]?.trim() ? " is-answered" : ""}`}
                aria-current={index === i ? "step" : undefined}
                aria-label={t("simulation.questionState", {
                  count: i + 1,
                  state: t(
                    shown[q.id]?.trim()
                      ? "simulation.answered"
                      : "simulation.unanswered",
                  ),
                })}
                key={q.id}
                onClick={() => setIndex(i)}
              >
                {i + 1}
                {shown[q.id]?.trim() && <Check size={14} aria-hidden />}
              </button>
            ))}
          </nav>
          {question && (
            <>
              <h2 className="small">
                {t("quiz.position", {
                  current: index + 1,
                  total: run.questions.length,
                })}
              </h2>
              <MarkdownView>{question.stem}</MarkdownView>
              <MathInput
                ariaLabel={t("quiz.yourAnswer")}
                value={shown[question.id] ?? ""}
                disabled={locked || busy}
                autoSize={{ minRows: 7, maxRows: 16 }}
                maxLength={20000}
                onChange={(answer) => {
                  const next = { ...shown, [question.id]: answer };
                  setPicks(next);
                  drafts.schedule({ attemptId: run.attemptId, picks: next });
                }}
              />
            </>
          )}
        </section>
      )}
      {run?.submitted && (
        <div className="px-sim-export">
          <ExportButton
            planId={planId}
            kind="simulation"
            attemptId={run.attemptId}
          />
          {/* A new simulation from the setup; this one keeps its answers and grade. */}
          <Button shape="round" onClick={() => navigate(`/plans/${planId}/simulation`)}>
            {t("quiz.redo")}
          </Button>
        </div>
      )}
      <Modal
        title={t("simulation.deliver")}
        open={confirm}
        onCancel={() => setConfirm(false)}
        okText={t("simulation.submit")}
        cancelText={t("simulation.keepWriting")}
        onOk={() => void submit()}
      >
        <p className="body">{t("simulation.confirm", { count: unanswered })}</p>
      </Modal>
    </FocusLayout>
  );
}

/** The exam's time left. It ticks on its own, so the page re-renders only when time is up. */
function SimulationClock({ deadline, stopped }: { deadline: number; stopped: boolean }) {
  const { t } = useTranslation();
  const now = useNow(1000, !stopped);
  const seconds = stopped ? 0 : Math.max(0, Math.ceil((deadline - now) / 1000));
  const time = `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  return (
    <span className="code px-sim-timer" role="timer" aria-label={t("simulation.timeLeft")}>
      {time}
    </span>
  );
}
