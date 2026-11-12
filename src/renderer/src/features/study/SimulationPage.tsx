import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { useMenuLock } from "../../app/menu-state";
import { MathInput } from "../../components/MathInput";
import { MarkdownView } from "../../components/MarkdownView";
import { Notice } from "../../components/Notice";
import { StepLines } from "../../components/StepLines";
import { ExportButton } from "../share/ExportButton";
import { useEngineError } from "../../lib/engineError";
import { useEngineNames } from "../../lib/useEngineNames";
import { invoke } from "../../lib/ipc";
import { useGradeScale } from "../../lib/useGradeScale";
import { jobErrorEngine, jobErrorKey } from "../jobs/jobErrors";
import { useActiveTime } from "./activeTime";
import { useDeadlinePassed, useNow } from "./clock";
import { useDraftSaver } from "./draftSaver";
import { ActivityChoice, ActivityIntro } from "./ActivityIntro";
import { ResultsScreen, type ResultItem } from "./ResultsScreen";
import { StudyLayout } from "./StudyBar";
import { HandInConfirm, QuizColumn, type HandInFrom } from "./QuizColumn";
import { Button as PxButton } from "../../components/Button";
import { resumeIndex, toggleMarked } from "./quizSheet";
import { questionPoints, verdict, verdictLine } from "./quizText";
import "./SimulationPage.css";
import { pastPapersQuery, usePlan } from "../../lib/queries";

/** How long typing pauses before the answers are saved. */
const DRAFT_DELAY_MS = 500;

export function SimulationPage() {
  const { t, i18n } = useTranslation();
  const engineNames = useEngineNames();
  const grade = useGradeScale();
  const describeEngineError = useEngineError();
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
  // Where the student moved to in this attempt; until they move, the exam opens where it was left.
  const [moved, setMoved] = useState<{ attemptId: string; index: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [noEngine, setNoEngine] = useState(false);
  // Questions marked "Segna per dopo", once the student changes them; until then the saved list.
  const [markedHere, setMarkedHere] = useState<string[] | null>(null);
  // The Consegna question, open under the button that asked it.
  const [confirmFrom, setConfirmFrom] = useState<HandInFrom | null>(null);
  const card = useRef<HTMLElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  // Typing saves at most every DRAFT_DELAY_MS; time-up, submit and leaving the page save at once.
  const drafts = useDraftSaver(
    (draft: { attemptId: string; picks: Record<string, string>; marked: string[]; current: string }) =>
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
  // Worked out once per attempt from a read made since the page opened, so a later read (every second) never moves the
  // question the student is on. A read cached from an earlier visit can predate the last draft that visit saved, as
  // when Avanti and "Segna per dopo" come just before leaving; until the fresh read is in, the cached one stands in.
  const fresh = open.isFetchedAfterMount;
  const resumed = useMemo(
    () =>
      run
        ? resumeIndex(
            run.questions.map((q) => q.id),
            run.current,
            (id) => (run.picks[id] ?? "").trim() !== "",
          )
        : 0,
    [run?.attemptId, fresh],
  );
  const index = run && moved?.attemptId === run.attemptId ? moved.index : resumed;
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
    setMarkedHere(null);
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
  const marked = markedHere ?? run?.marked ?? [];
  const unanswered =
    run?.questions.filter((q) => !(shown[q.id] ?? "").trim()).length ?? 0;
  // A new question takes focus, so a screen reader reads its position and its text; the card shows no focus box.
  useEffect(() => {
    if (question) card.current?.focus({ preventScroll: true });
  }, [question?.id]);
  // Every draft carries the open question, so the newest save is also the newest position.
  function save(next: { picks?: Record<string, string>; marked?: string[]; current?: string }) {
    const current = next.current ?? question?.id;
    if (!run || !current) return;
    drafts.schedule({ attemptId: run.attemptId, picks: next.picks ?? shown, marked: next.marked ?? marked, current });
  }
  function goTo(next: number) {
    setConfirmFrom(null);
    if (!run) return;
    setMoved({ attemptId: run.attemptId, index: next });
    const id = run.questions[next]?.id;
    if (id && !locked) save({ current: id });
  }
  // Blank answers are handed in as blank; the question says how many when there are any, or any marked for later.
  function requestHandIn(from: HandInFrom) {
    if (!run || locked || busy) return;
    if (unanswered || marked.length) setConfirmFrom(from);
    else void submit();
  }
  function cancelHandIn() {
    const from = confirmFrom;
    setConfirmFrom(null);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(from === "nav" ? ".px-qz-nav .px-btn-primary" : ".px-qz-handin > .px-btn")
        ?.focus(),
    );
  }
  const provenance = [
    ...new Set(
      run?.results
        ?.filter((r) => r.provider && r.model)
        .map((r) => engineNames.label(r.provider, r.model)) ?? [],
    ),
  ].join(", ");
  // A plan file carries that the exam was handed in, not the answers or the grade.
  const noAnswers = Boolean(run?.submitted) && run?.score === undefined && !run?.results?.length;
  async function submit() {
    if (!run || busy) return;
    setConfirmFrom(null);
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
        model: engineNames.label(run.generated.provider, run.generated.model),
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
  // The exam is on: its questions are answered, or wait for an engine after time ran out.
  const running = Boolean(run && !run.submitted && !run.grading);
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
  // The results screen. While grading runs the job grades the exercises in order, so the first `gradedCount` have a grade.
  const gradingStopped =
    Boolean(run && !run.submitted && run.grading) &&
    ["failed", "cancelled", "interrupted"].includes(run?.grading?.state ?? "");
  // Grading that stopped on a refused sign-in names the engine and offers its sign-in.
  const gradingError = run?.grading?.error;
  const gradingFailure = gradingError
    ? describeEngineError(jobErrorKey(gradingError), jobErrorEngine(gradingError))
    : undefined;
  const gradedCount = run?.submitted
    ? run.questions.length
    : Math.round((run?.grading?.progress ?? 0) * (run?.questions.length ?? 0));
  const simMistakes = Boolean(run?.results?.some((result) => result.score < 1));
  async function ask(stem: string, answer: string, expected: string, feedback: string) {
    try {
      const seeded = await invoke("chats.seed", {
        kind: "answer",
        title: stem.slice(0, 80),
        body: `${t("quiz.question")}: ${stem}\n${t("quiz.yourAnswer")}: ${answer}\n${t("simulation.reference")}: ${expected}\n${feedback}`,
      });
      navigate(`/ask/${seeded.chatId}`);
    } catch {
      setNotice(t("simulation.actionFailed"));
    }
  }
  const simItems: ResultItem[] = (run?.questions ?? []).map((q, i) => {
    const result = run?.results?.find((row) => row.id === q.id);
    const answer = run?.picks[q.id] ?? "";
    const topic = plan.data?.topics.find((row) => row.id === q.topicId)?.title;
    if (!result)
      return {
        id: q.id,
        stem: q.stem,
        topic,
        mark: gradingStopped ? "ungraded" : i === gradedCount ? "grading" : "queued",
        answer,
        typed: "math",
        long: true,
        expectedLabel: t("simulation.reference"),
      };
    return {
      id: q.id,
      stem: q.stem,
      topic,
      mark: verdict(result.score),
      value: result.score,
      ...(verdict(result.score) === "partial"
        ? { score: t("quiz.questionPoints", { points: questionPoints(result.score, i18n.language) }) }
        : {}),
      answer,
      typed: "math",
      long: true,
      expected: result.expected,
      expectedLabel: t("simulation.reference"),
      explanation: result.feedback,
      missed: result.missed,
      grader: result.provider && result.model ? engineNames.label(result.provider, result.model) : undefined,
      // The tutor unlocks once the exam is handed in.
      ...(run?.submitted
        ? { onAsk: () => void ask(q.stem, answer || t("simulation.blank"), result.expected, result.feedback) }
        : {}),
    };
  });
  return (
    <StudyLayout
      // A running exam has no way out until it is handed in, as in the exam room.
      back={
        !run || run.submitted || locked
          ? {
              text: plan.data?.title ?? t("lesson.back"),
              label: plan.data ? t("lesson.back") : undefined,
              onClick: () => navigate(`/plans/${planId}`),
            }
          : undefined
      }
      title={run?.submitted ? `${t("results.title")} \u00b7 ${t("simulation.title")}` : t("simulation.title")}
      subtitle={[plan.data?.subject, plan.data?.title].filter(Boolean).join(" \u00b7 ") || undefined}
      wide={running}
      // On the answer sheet the question card's "Domanda 3 di 8" is the page's heading.
      heading={!running}
      actions={
        // The clock belongs to the exam; Consegna sits in the Domande card. Once graded the results take over.
        running && run ? (
          <div className="px-sim-header-actions">
            <SimulationClock
              deadline={run.deadline}
              stopped={Boolean(run.locked) || timeUp}
            />
          </div>
        ) : undefined
      }
      secondary={
        // The results screen has its own way back; a locked exam waiting for an engine needs one here.
        run && !run.submitted && !run.grading && locked ? (
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
      {run && !running ? noticeBox : null}
      {run && !running && run.blocked && (
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
      {generated && !run && (
        <Notice tone="warning">{generated}</Notice>
      )}
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
      ) : run.submitted && noAnswers ? (
        <section className="px-sim-results">
          <Notice tone="info">{t("quiz.answersNotShared")}</Notice>
          <div className="px-sim-export">
            <ExportButton planId={planId} kind="simulation" attemptId={run.attemptId} />
            <Button shape="round" onClick={() => navigate(`/plans/${planId}/simulation`)}>
              {t("quiz.redo")}
            </Button>
            <Button type="primary" shape="round" onClick={() => navigate(`/plans/${planId}`)}>
              {t("lesson.backToPath")}
            </Button>
          </div>
        </section>
      ) : run.submitted || run.grading ? (
        <ResultsScreen
          kind="simulation"
          attemptId={run.attemptId}
          planId={planId}
          // Ripasso mirato: a drill on the gap this exam opened, or its wrong answers asked again.
          review={
            run.submitted && simMistakes
              ? {
                  count: run.results?.filter((result) => result.score < 1).length ?? 0,
                  onReview: () => navigate(`/plans/${planId}/review?from=${encodeURIComponent(run.attemptId)}`),
                }
              : undefined
          }
          eyebrow={
            run.submitted && run.submittedAt
              ? t("results.resultOn", {
                  date: `${new Date(run.submittedAt).toLocaleDateString(i18n.language, {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                  })} · ${t("simulation.minutes", { count: run.minutes })}`,
                })
              : t("results.result")
          }
          grade={run.submitted ? run.score : undefined}
          headline={
            run.submitted && run.score !== undefined
              ? t(verdictLine(run.score * 100, false, plan.data ? plan.data.target * 100 : undefined))
              : t("results.gradingHeadline")
          }
          detail={
            run.submitted
              ? undefined
              : [
                  t("results.gradingCount", {
                    done: gradedCount,
                    total: run.questions.length,
                    count: run.questions.length,
                  }),
                  gradingStopped ? "" : t("results.gradeLater"),
                ]
                  .filter(Boolean)
                  .join(" ")
          }
          goal={plan.data?.target}
          grading={
            run.submitted ? undefined : { done: gradedCount, total: run.questions.length }
          }
          stopped={gradingStopped}
          notes={
            <>
              {run.submitted ? (
                <p className="small">
                  {provenance
                    ? t("simulation.modelGrade", { model: provenance })
                    : t("simulation.localGrade")}
                </p>
              ) : null}
              {generated ? <Notice tone="warning">{generated}</Notice> : null}
              {gradingStopped ? (
                <Notice
                  tone="danger"
                  details={run.grading?.error?.slice(0, 2000)}
                  action={gradingFailure?.action}
                >
                  {gradingFailure?.action
                    ? `${t("simulation.gradeFailed")} ${gradingFailure.text}`
                    : t("simulation.gradeFailed")}
                </Notice>
              ) : null}
            </>
          }
          topics={
            run.submitted
              ? run.topics.map((topic) => ({
                  id: topic.id,
                  title: topic.title,
                  share: topic.score,
                  value: grade.format(topic.score),
                }))
              : []
          }
          topicsLabel={t("simulation.byTopic")}
          primary={
            gradingStopped ? (
              <Button type="primary" shape="round" size="large" disabled={busy} onClick={() => void submit()}>
                {t("simulation.retryGrade")}
              </Button>
            ) : run.submitted && simMistakes ? undefined : (
              <Button type="primary" shape="round" size="large" onClick={() => navigate(`/plans/${planId}`)}>
                {t("lesson.backToPath")}
              </Button>
            )
          }
          secondary={
            gradingStopped || (run.submitted && simMistakes) ? (
              <Button
                type={gradingStopped ? "text" : "default"}
                shape="round"
                size="large"
                onClick={() => navigate(`/plans/${planId}`)}
              >
                {t("lesson.backToPath")}
              </Button>
            ) : undefined
          }
          extra={
            run.submitted ? (
              <>
                <Button type="text" shape="round" onClick={() => setExportOpen(true)}>
                  {t("export.title")}
                </Button>
                <ExportButton
                  planId={planId}
                  kind="simulation"
                  attemptId={run.attemptId}
                  open={exportOpen}
                  onOpenChange={setExportOpen}
                />
                {/* A new simulation from the setup; this one keeps its answers and grade. */}
                <Button type="text" shape="round" onClick={() => navigate(`/plans/${planId}/simulation`)}>
                  {t("quiz.redo")}
                </Button>
              </>
            ) : undefined
          }
          after={!run.submitted && !gradingStopped ? t("simulation.frozen") : undefined}
          items={simItems}
          listNote={
            !run.submitted && run.grading?.model
              ? t("results.gradingWith", {
                  model: engineNames.label(run.grading.provider, run.grading.model),
                })
              : undefined
          }
        />
      ) : (
        <QuizColumn
          items={run.questions.map((q) => ({
            id: q.id,
            given: (shown[q.id] ?? "").trim() ? ("answer" as const) : ("none" as const),
            marked: marked.includes(q.id),
          }))}
          current={index}
          onJump={goTo}
          handIn={{ disabled: locked || busy, onRequest: requestHandIn }}
          confirm={
            confirmFrom
              ? {
                  from: confirmFrom,
                  content: (
                    <HandInConfirm
                      blank={unanswered}
                      marked={marked.length}
                      busy={busy}
                      onConfirm={() => void submit()}
                      onCancel={cancelHandIn}
                    />
                  ),
                }
              : undefined
          }
          before={
            noticeBox || run.blocked || generated || open.isError ? (
              <>
                {noticeBox}
                {run.blocked ? (
                  <Notice
                    tone="warning"
                    action={{ label: t("simulation.openSettings"), onClick: () => navigate("/settings") }}
                  >
                    {t("simulation.noEngineLocked")}
                  </Notice>
                ) : null}
                {generated ? <Notice tone="warning">{generated}</Notice> : null}
                {open.isError ? <Notice tone="warning">{t("simulation.actionFailed")}</Notice> : null}
              </>
            ) : undefined
          }
          card={
            question ? (
              <section
                ref={card}
                tabIndex={-1}
                className="px-qz-sheet"
                aria-labelledby="sim-position"
                aria-describedby="sim-stem"
              >
                <div className="px-qz-head">
                  <h1 id="sim-position">
                    {t("quiz.position", { current: index + 1, total: run.questions.length })}
                  </h1>
                  <span className="px-qz-kicker">{t("quiz.kinds.open")}</span>
                </div>
                <div id="sim-stem" className="px-qz-stem">
                  <MarkdownView>{question.stem}</MarkdownView>
                </div>
                <MathInput
                  ariaLabel={t("quiz.yourAnswer")}
                  value={shown[question.id] ?? ""}
                  disabled={locked || busy}
                  autoSize={{ minRows: 7, maxRows: 16 }}
                  maxLength={20000}
                  onChange={(answer) => {
                    const next = { ...shown, [question.id]: answer };
                    setPicks(next);
                    save({ picks: next });
                  }}
                />
                <div className="px-qz-acts">
                  <PxButton
                    variant="ghost"
                    icon="flag"
                    className="is-mark"
                    pressed={marked.includes(question.id)}
                    disabled={locked || busy}
                    onClick={() => {
                      const next = toggleMarked(marked, question.id, run.questions.map((q) => q.id));
                      setMarkedHere(next);
                      save({ marked: next });
                    }}
                  >
                    {t("quiz.sheet.mark")}
                  </PxButton>
                </div>
              </section>
            ) : null
          }
          nav={
            <>
              {index > 0 ? (
                <PxButton variant="secondary" icon="chevron-left" onClick={() => goTo(index - 1)}>
                  {t("nav.back")}
                </PxButton>
              ) : null}
              <span className="px-qz-grow" />
              {index + 1 < run.questions.length ? (
                <PxButton key="next" size="lg" iconEnd="chevron-right" onClick={() => goTo(index + 1)}>
                  {t("quiz.next")}
                </PxButton>
              ) : (
                <PxButton
                  key="handin"
                  size="lg"
                  disabled={locked || busy}
                  expanded={confirmFrom === "nav"}
                  onClick={() => requestHandIn("nav")}
                >
                  {t("quiz.sheet.handIn")}
                </PxButton>
              )}
            </>
          }
        />
      )}
    </StudyLayout>
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
