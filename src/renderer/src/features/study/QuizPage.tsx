import { useMutation, useQuery } from "@tanstack/react-query";
import { App, Button, Input, InputNumber, Select } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { QUIZ_MAX_QUESTIONS, quizMinutes } from "@shared/quiz";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { Icon } from "../../components/Icon";
import { Notice } from "../../components/Notice";
import { QuizOption, type QuizOptionState } from "../../components/QuizOption";
import { StepLines } from "../../components/StepLines";
import { Tag } from "../../components/Tag";
import { InlineMarkdown } from "../../components/InlineMarkdown";
import { MathInput } from "../../components/MathInput";
import { MarkdownView } from "../../components/MarkdownView";
import { openSourceViewer } from "../../components/SourceViewer";
import { ExportButton } from "../share/ExportButton";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";
import { useReviewSession } from "./ReviewProgress";
import { QuizIntro } from "./QuizIntro";
import { QuizResults } from "./QuizResults";
import {
  blanks,
  pairs,
  stemText,
  verdict,
  type QuizAnswer,
} from "./quizText";
import "./QuizPage.css";

const KINDS = ["mcq", "completion", "matching", "tf", "open"] as const;
type Kind = (typeof KINDS)[number];
const SCOPES = ["topic", "plan", "page"] as const;
type Scope = (typeof SCOPES)[number];
function clock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return total >= 3600
    ? `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
    : `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

export function QuizPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { planId, topicId } = useParams();
  useActiveTime(planId, topicId ?? null);
  const navigate = useNavigate();
  const diagnostic = !topicId;
  const [searchParams, setSearchParams] = useSearchParams();
  const savedAttempt = searchParams.get("attempt");
  const restoredAttempt = useRef<string | null>(null);
  const [hydratedAttempt, setHydratedAttempt] = useState<string | null>(null);
  const draftToSave = useRef<{
    attemptId: string;
    planId?: string;
    picks: Record<string, string>;
    index: number;
  } | null>(null);
  const [types, setTypes] = useState<Kind[]>([...KINDS]);
  const [scope, setScope] = useState<Scope>("topic");
  const [pageSource, setPageSource] = useState<string>();
  const [page, setPage] = useState<number | null>(1);
  const [timerOn, setTimerOn] = useState(false);
  const [timerMinutes, setTimerMinutes] = useState<number | null>(20);
  const plan = useQuery({
    queryKey: ["plan", planId],
    enabled: Boolean(planId),
    queryFn: () => invoke("plans.read", { planId: planId ?? "" }),
  });
  const preview = useQuery({
    queryKey: ["diagnostic-preview", planId],
    enabled: diagnostic && !savedAttempt && Boolean(planId),
    queryFn: () =>
      invoke("study.diagnosticPreview", { planId: planId ?? "" }),
  });
  const library = useQuery({
    queryKey: ["sources"],
    queryFn: () => invoke("sources.list", {}),
    enabled: scope === "page",
  });
  const pageReady = scope !== "page" || (Boolean(pageSource) && Boolean(page));
  const timerReady = !timerOn || Boolean(timerMinutes);
  const [index, setIndex] = useState(0);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, QuizAnswer>>({});
  const [wrongMarks, setWrongMarks] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState(false);
  const heading = useRef<HTMLDivElement>(null);
  const start = useMutation({
    mutationFn: () =>
      topicId
        ? invoke("study.quizStart", {
            planId: planId ?? "",
            scope,
            ...(scope === "topic" ? { topicId } : {}),
            ...(scope === "page"
              ? { sourceId: pageSource, page: page ?? undefined }
              : {}),
            types,
            ...(timerOn && timerMinutes ? { timerMinutes } : {}),
          })
        : invoke("study.diagnosticStart", { planId: planId ?? "" }),
    onSuccess: (session) => {
      if (session.attemptId)
        setSearchParams({ attempt: session.attemptId }, { replace: true });
    },
  });
  const attemptId = savedAttempt ?? start.data?.attemptId ?? "";
  const session = useQuery({
    queryKey: ["quiz-session", attemptId],
    queryFn: () => invoke("study.quizRead", { attemptId, planId }),
    enabled: Boolean(attemptId),
    refetchInterval: (query) =>
      query.state.data &&
      ["succeeded", "failed", "cancelled", "interrupted"].includes(
        query.state.data.state,
      )
        ? false
        : 500,
  });
  const review = Boolean(session.data?.review);
  const reviewQueue = useReviewSession(planId, review);
  // A gap drill still owes this review questions; the core adds them to this attempt when it finishes.
  const owed = reviewQueue.data?.progress.questionsPending ?? 0;
  const queued = reviewQueue.data?.progress.questionsTotal;
  useEffect(() => {
    if (queued != null && queued !== session.data?.questions.length) void session.refetch();
  }, [queued]);
  // LES-03: a gap drill opens with its short explanation; in a Review, each delivered drill brings its own.
  const drillNotes = [
    session.data?.explanation,
    ...(reviewQueue.data?.explanations ?? []).map((note) => `**${note.title}.** ${note.text}`),
  ].filter((note): note is string => Boolean(note));
  const questions = session.data?.questions ?? start.data?.questions ?? [];
  const requestedCount = diagnostic
    ? questions.length
    : (session.data?.requestedCount ?? QUIZ_MAX_QUESTIONS);
  const generationFailed = Boolean(
    session.data &&
    ["failed", "cancelled", "interrupted"].includes(session.data.state),
  );
  const generating =
    !diagnostic &&
    Boolean(attemptId) &&
    !generationFailed &&
    session.data?.state !== "succeeded";
  const canFinish =
    (diagnostic && owed === 0) ||
    (!diagnostic && session.data?.state === "succeeded" && questions.length >= requestedCount);
  const retry = useMutation({
    mutationFn: async () => {
      if (!session.data?.jobId) return;
      await invoke(
        session.data.state === "interrupted" ? "jobs.resume" : "jobs.retry",
        { jobId: session.data.jobId },
      );
      await session.refetch();
    },
  });
  useEffect(() => {
    if (!session.data) return;
    const restoring = restoredAttempt.current !== attemptId;
    setChecked((current) => ({
      ...(restoring ? {} : current),
      ...Object.fromEntries(session.data.checked.map((row) => [row.id, row])),
    }));
    setPicks((current) => {
      const merged = {
        ...(restoring ? {} : current),
        ...(restoring ? session.data.draft?.picks : undefined),
        ...Object.fromEntries(
          session.data.checked.map((row) => [row.id, row.pick]),
        ),
        ...session.data.result?.picks,
      };
      return Object.keys(merged).length === Object.keys(current).length &&
        Object.entries(merged).every(([key, value]) => current[key] === value)
        ? current
        : merged;
    });
    if (restoring) {
      restoredAttempt.current = attemptId;
      const firstUnchecked = session.data.questions.findIndex(
        (row) => !session.data.checked.some((answer) => answer.id === row.id),
      );
      setIndex(
        Math.min(
          Math.max(
            0,
            session.data.draft?.index ??
              (firstUnchecked < 0
                ? session.data.questions.length - 1
                : firstUnchecked),
          ),
          Math.max(0, session.data.questions.length - 1),
        ),
      );
      setHydratedAttempt(attemptId);
    }
  }, [session.data, attemptId]);
  const question = questions[index];
  const check = useMutation({
    mutationFn: (input: { questionId: string; pick: string }) =>
      invoke("study.quizCheck", { attemptId, ...input }),
    onSuccess: (result) =>
      setChecked((current) => ({ ...current, [result.id]: result })),
  });
  // An open answer the student stopped checking goes back to editable, without an error.
  const cancelledCheck = useRef<string | null>(null);
  const checking = check.isPending ? check.variables?.questionId : undefined;
  const checkFailed =
    check.isError &&
    check.variables?.questionId === question?.id &&
    cancelledCheck.current !== question?.id;
  // Answers are corrected one by one; submitting only closes the attempt (and grades anything still unchecked).
  const grading = useQuery({
    queryKey: ["quiz-grading", attemptId],
    queryFn: () => invoke("study.quizGrading", { attemptId }),
    enabled: Boolean(attemptId),
    refetchInterval: (query) =>
      ["queued", "running"].includes(query.state.data?.state ?? "")
        ? 500
        : false,
  });
  const submit = useMutation({
    mutationFn: () =>
      invoke("study.quizSubmit", {
        attemptId,
        picks,
      }),
    onSuccess: () => void grading.refetch(),
  });
  const control = useMutation({
    mutationFn: async (
      action: "jobs.cancel" | "jobs.retry" | "jobs.resume",
    ) => {
      if (!grading.data?.jobId) return;
      await invoke(action, { jobId: grading.data.jobId });
      await grading.refetch();
    },
  });
  const finalResult = grading.data?.result ?? session.data?.result;
  const gradeState = grading.data?.state ?? "none";
  const gradingStopped = ["failed", "cancelled", "interrupted"].includes(
    gradeState,
  );
  const gradingStarted =
    !finalResult &&
    (submit.isPending || Boolean(submit.data?.jobId) || gradeState !== "none");
  // The deadline is persisted by main; the page only renders it and submits through the normal grading job.
  const deadlineAt = session.data?.deadlineAt;
  const timed = Boolean(session.data?.timerMinutes);
  const [now, setNow] = useState(() => Date.now());
  const running = Boolean(deadlineAt) && !finalResult && !gradingStarted;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const msLeft = deadlineAt ? Math.max(0, deadlineAt - now) : undefined;
  const expired = msLeft === 0;
  const autoSubmitted = useRef(false);
  useEffect(() => {
    if (
      !expired ||
      !running ||
      !canFinish ||
      hydratedAttempt !== attemptId ||
      submit.isPending ||
      autoSubmitted.current
    )
      return;
    autoSubmitted.current = true;
    submit.mutate();
  }, [expired, running, canFinish, hydratedAttempt, attemptId]);
  useEffect(() => {
    draftToSave.current =
      attemptId &&
      hydratedAttempt === attemptId &&
      !finalResult &&
      !gradingStarted &&
      !expired &&
      session.data?.submittedAt == null
        ? { attemptId, planId, picks, index }
        : null;
    if (!draftToSave.current) return;
    const timer = window.setTimeout(() => {
      void flushDraft();
    }, 500);
    return () => window.clearTimeout(timer);
  }, [
    attemptId,
    hydratedAttempt,
    picks,
    index,
    finalResult,
    gradingStarted,
    expired,
    canFinish,
    session.data?.submittedAt,
  ]);
  useEffect(
    () => () => {
      const draft = draftToSave.current;
      if (draft) void invoke("study.quizDraft", draft).catch(() => undefined);
    },
    [],
  );
  async function flushDraft() {
    const draft = draftToSave.current;
    if (!draft) return;
    try {
      await invoke("study.quizDraft", draft);
      // The first save after the quiz is ready starts the timer; pick up its deadline.
      if (timed && !deadlineAt && canFinish) void session.refetch();
    } catch {
      setActionError(true);
    }
  }
  // Answers, checks and the current question are saved, so closing never loses work.
  async function close() {
    await flushDraft();
    navigate(`/plans/${planId ?? ""}`);
  }
  const result = question ? checked[question.id] : undefined;
  const locked =
    Boolean(result) ||
    checking === question?.id ||
    submit.isPending ||
    gradingStarted ||
    expired ||
    (Boolean(attemptId) && hydratedAttempt !== attemptId);
  const [remaining, setRemaining] = useState(10);
  useEffect(() => {
    setRemaining(10);
  }, [question?.id]);
  useEffect(() => {
    if (question?.grade.kind !== "tf" || result || finalResult) return;
    const deadline = Date.now() + 10000;
    const timer = window.setInterval(
      () => setRemaining(Math.max(0, (deadline - Date.now()) / 1000)),
      100,
    );
    return () => window.clearInterval(timer);
  }, [question?.id, question?.grade.kind, result, finalResult]);
  // A new question takes focus for screen readers; the stem shows no focus box for it.
  useEffect(() => {
    if (question) heading.current?.focus({ preventScroll: false });
  }, [question?.id]);
  function pick(value: string) {
    if (question && !locked)
      setPicks((current) => ({ ...current, [question.id]: value }));
  }
  function goTo(next: number) {
    check.reset();
    setIndex(next);
  }
  function runCheck() {
    if (!question || !hasAnswer || locked) return;
    cancelledCheck.current = null;
    check.mutate({ questionId: question.id, pick: picks[question.id] ?? "" });
  }
  function stopCheck() {
    if (!question) return;
    cancelledCheck.current = question.id;
    void invoke("study.quizCheckCancel", {
      attemptId,
      questionId: question.id,
    }).catch(() => setActionError(true));
  }
  function finishNow() {
    if (canFinish && !gradingStarted && !submit.isPending) submit.mutate();
  }
  function answerText(id: string): string {
    const item = questions.find((row) => row.id === id);
    const raw = picks[id] ?? "";
    if (!raw) return "";
    if (item?.grade.kind === "mcq") return item.options?.[Number(raw)] ?? raw;
    if (item?.grade.kind === "tf")
      return raw === "true"
        ? t("quiz.true")
        : raw === "false"
          ? t("quiz.false")
          : "";
    if (item?.grade.kind === "completion") return blanks(raw).join(", ");
    if (item?.grade.kind === "matching")
      return pairs(raw)
        .map(([left, right]) => `${left} = ${right}`)
        .join("; ");
    return raw;
  }
  function expectedText(answer: QuizAnswer): string {
    const item = questions.find((row) => row.id === answer.id);
    return item?.grade.kind === "tf"
      ? t(answer.expected === "true" ? "quiz.true" : "quiz.false")
      : answer.expected;
  }
  async function ask(answer: QuizAnswer) {
    const item = questions.find((row) => row.id === answer.id);
    if (!item) return;
    try {
      const seeded = await invoke("chats.seed", {
        kind: "answer",
        title: item.stem.slice(0, 80),
        body: `${t("quiz.question")}: ${item.stem}\n${t("quiz.yourAnswer")}: ${answerText(answer.id)}\n${t("quiz.expected")}: ${expectedText(answer)}\n${answer.explanation}`,
      });
      navigate(`/ask/${seeded.chatId}`);
    } catch {
      setActionError(true);
    }
  }
  const markWrong = useMutation({
    mutationFn: (input: { questionId: string; wrong: boolean }) =>
      invoke("study.quizWrong", { attemptId, ...input }),
    onSuccess: (_, input) => {
      setWrongMarks((current) => ({
        ...current,
        [input.questionId]: input.wrong,
      }));
      void session.refetch();
      void grading.refetch();
      const key = `quiz-wrong-${input.questionId}`;
      if (input.wrong)
        void message.open({
          key,
          type: "info",
          duration: 6,
          content: (
            <span className="px-quiz-toast">
              {t("quiz.wrongDone")}
              <Button
                type="link"
                size="small"
                onClick={() => {
                  message.destroy(key);
                  markWrong.mutate({
                    questionId: input.questionId,
                    wrong: false,
                  });
                }}
              >
                {t("quiz.wrongUndo")}
              </Button>
            </span>
          ),
        });
      else message.destroy(key);
    },
    onError: () => setActionError(true),
  });
  const rawPick = question ? (picks[question.id] ?? "") : "";
  const blankCount = question
    ? Math.max(1, [...question.stem.matchAll(/\{\{\d+\}\}/g)].length)
    : 1;
  const hasAnswer = Boolean(
    question &&
    (question.grade.kind === "completion"
      ? Array.from(
          { length: blankCount },
          (_, i) => blanks(rawPick)[i] ?? "",
        ).every((value) => value.trim())
      : question.grade.kind === "matching"
        ? question.left?.every((_, i) => pairs(rawPick)[i]?.[1]?.trim())
        : rawPick.trim()),
  );
  const primary = expired
    ? {
        key: "finish",
        label: t("quiz.finish"),
        onClick: finishNow,
        disabled: !canFinish,
        loading: submit.isPending,
      }
    : !result
      ? {
          key: "check",
          label: t("quiz.submit"),
          onClick: runCheck,
          disabled: !hasAnswer || (locked && checking !== question?.id),
          loading: checking === question?.id,
        }
      : index + 1 < questions.length
        ? {
            key: "next",
            label: t("quiz.next"),
            onClick: () => goTo(index + 1),
            disabled: false,
            loading: false,
          }
        : canFinish
          ? {
              key: "results",
              label: t("quiz.seeResults"),
              onClick: finishNow,
              disabled: gradingStarted,
              loading: submit.isPending,
            }
          : {
              key: "wait",
              label: t("quiz.waitingBatch"),
              onClick: () => undefined,
              disabled: true,
              loading: false,
            };
  // Keys: 1–4 pick an option, Enter checks or moves on. Typing in a field and real buttons keep their own keys.
  const keys = useRef({ primary, pick, question, locked });
  keys.current = { primary, pick, question, locked };
  const answering = Boolean(question) && !finalResult && !gradingStarted;
  useEffect(() => {
    if (!answering) return;
    const onKey = (event: KeyboardEvent) => {
      const current = keys.current;
      if (event.altKey || event.repeat || event.defaultPrevented || !current.question) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("[role=dialog], .ant-drawer, .ant-select-dropdown")) return;
      const field = target?.closest("input, textarea, select, [contenteditable=true], .px-mathinput");
      if (event.key === "Enter") {
        if (event.shiftKey) return;
        const option = target?.closest(".px-opt");
        const control = target?.closest("button, a, summary, select, [role=button]");
        // Enter on an option not yet picked picks it, like any button.
        if (option && option.getAttribute("aria-pressed") !== "true") return;
        if (control && !option) return;
        const singleLine =
          target instanceof HTMLInputElement && target.type === "text";
        if (field && !singleLine && !(event.ctrlKey || event.metaKey)) return;
        if (current.primary.disabled || current.primary.loading) return;
        event.preventDefault();
        current.primary.onClick();
        return;
      }
      if (event.ctrlKey || event.metaKey || field || current.locked) return;
      if (!/^[1-4]$/.test(event.key)) return;
      const option = Number(event.key) - 1;
      const kind = current.question.grade.kind;
      if (kind === "tf" && option < 2) {
        event.preventDefault();
        current.pick(option === 0 ? "true" : "false");
      } else if (kind === "mcq" && option < (current.question.options?.length ?? 0)) {
        event.preventDefault();
        current.pick(String(option));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [answering]);
  const error =
    start.error ||
    session.error ||
    retry.error ||
    submit.error ||
    control.error ||
    actionError;
  const errorKey =
    error && typeof error === "object" && "messageKey" in error
      ? String(error.messageKey)
      : start.error?.message.includes("page-empty")
        ? "quiz.pageEmpty"
        : "quiz.error";
  // A mixed review counts its cards and questions as one queue, so the position and bar cover both.
  const wholeReview =
    session.data?.review && reviewQueue.data
      ? reviewQueue.data.progress
      : undefined;
  const answered = questions.filter((row) => checked[row.id]).length;
  const topic = plan.data?.topics.find((row) => row.id === topicId);
  const showIntro = !start.data && !savedAttempt;
  const kind = question?.grade.kind;
  const options =
    question && (kind === "mcq" || kind === "tf")
      ? kind === "tf"
        ? [t("quiz.true"), t("quiz.false")]
        : (question.options ?? [])
      : [];
  const valueOf = (optionIndex: number) =>
    kind === "tf" ? (optionIndex === 0 ? "true" : "false") : String(optionIndex);
  const rightValue =
    result && kind === "tf"
      ? result.expected
      : result && kind === "mcq"
        ? String(options.indexOf(result.expected))
        : undefined;
  function optionState(value: string): QuizOptionState {
    const chosen = rawPick === value;
    if (!result) return chosen ? "selected" : "idle";
    if (value === rightValue) return chosen ? "correct" : "answer";
    return chosen ? "wrong" : "muted";
  }
  const wrongMarked = question
    ? (wrongMarks[question.id] ?? false)
    : false;
  return (
    <FocusLayout
      title={t("quiz.title")}
      onClose={() => void close()}
      meta={
        question && !finalResult && !showIntro
          ? wholeReview
            ? t("cards.reviewPosition", {
                current: wholeReview.cardsTotal + index + 1,
                total: wholeReview.total,
              })
            : t("quiz.position", { current: index + 1, total: requestedCount })
          : undefined
      }
      progress={
        questions.length
          ? finalResult
            ? 1
            : wholeReview
              ? (wholeReview.cardsTotal + answered) / wholeReview.total
              : answered / Math.max(1, requestedCount)
          : undefined
      }
    >
      {owed > 0 && !finalResult ? (
        <Notice
          tone="info"
          action={{
            label: t("quiz.drillOwedOpen"),
            onClick: () =>
              void flushDraft().then(() => navigate(`/plans/${planId ?? ""}/review`)),
          }}
        >
          {t("quiz.drillOwed", { count: owed })}
        </Notice>
      ) : null}
      {!diagnostic && attemptId && (generating || generationFailed) ? (
        <div className="px-quiz-generation">
          {generating && questions.length ? (
            <p className="meta" role="status">
              {t("quiz.available", {
                available: questions.length,
                total: requestedCount,
                count: requestedCount,
              })}
            </p>
          ) : null}
          {generationFailed ? (
            <>
              <p className="small" role="alert">
                {t(
                  session.data?.state === "cancelled"
                    ? "quiz.buildCancelled"
                    : "quiz.buildFailed",
                )}
              </p>
              {session.data?.jobId ? (
                <Button
                  shape="round"
                  loading={retry.isPending}
                  onClick={() => retry.mutate()}
                >
                  {t(
                    session.data.state === "interrupted"
                      ? "quiz.resume"
                      : "quiz.retry",
                  )}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {showIntro ? (
        <QuizIntro
          eyebrow={plan.data?.title ?? t("quiz.title")}
          title={diagnostic ? t("quiz.diagnostic") : (topic?.title ?? t("quiz.title"))}
          sentence={t(diagnostic ? "quiz.introDiagnostic" : "quiz.introTopic")}
          count={diagnostic ? preview.data?.count : QUIZ_MAX_QUESTIONS}
          minutes={
            diagnostic
              ? preview.data?.minutes
              : types.length
                ? quizMinutes(
                    Array.from(
                      { length: QUIZ_MAX_QUESTIONS },
                      (_, i) => types[i % types.length]!,
                    ),
                  )
                : undefined
          }
          answered={diagnostic ? preview.data?.answered : 0}
          starting={start.isPending}
          disabled={!diagnostic && (!types.length || !pageReady || !timerReady)}
          onStart={() => start.mutate()}
          onClose={() => navigate(`/plans/${planId ?? ""}`)}
          options={
            diagnostic ? undefined : (
              <>
                <fieldset className="px-quiz-types">
                  <legend className="body-strong">{t("quiz.scope")}</legend>
                  <div className="px-quiz-pills">
                    {SCOPES.map((item) => (
                      <button
                        key={item}
                        type="button"
                        className={
                          scope === item ? "choice is-selected" : "choice"
                        }
                        aria-pressed={scope === item}
                        disabled={start.isPending}
                        onClick={() => setScope(item)}
                      >
                        {t(`quiz.scopes.${item}`)}
                      </button>
                    ))}
                  </div>
                </fieldset>
                {scope === "page" ? (
                  <div className="px-quiz-page">
                    <label className="px-quiz-field">
                      <span className="small">{t("quiz.pageSource")}</span>
                      <Select
                        value={pageSource}
                        onChange={setPageSource}
                        disabled={start.isPending}
                        loading={library.isLoading}
                        placeholder={t("quiz.pageSourcePlaceholder")}
                        options={(library.data ?? [])
                          .filter((source) => source.status === "ready")
                          .map((source) => ({
                            value: source.id,
                            label: source.title,
                          }))}
                      />
                    </label>
                    <label className="px-quiz-field">
                      <span className="small">{t("quiz.pageNumber")}</span>
                      <InputNumber
                        min={1}
                        max={100000}
                        precision={0}
                        value={page}
                        onChange={setPage}
                        disabled={start.isPending}
                      />
                    </label>
                  </div>
                ) : null}
                <fieldset className="px-quiz-types">
                  <legend className="body-strong">{t("quiz.types")}</legend>
                  <div className="px-quiz-pills">
                    {KINDS.map((item) => (
                      <button
                        key={item}
                        type="button"
                        className={
                          types.includes(item) ? "choice is-selected" : "choice"
                        }
                        aria-pressed={types.includes(item)}
                        disabled={start.isPending}
                        onClick={() =>
                          setTypes((current) =>
                            current.includes(item)
                              ? current.filter((value) => value !== item)
                              : [...current, item],
                          )
                        }
                      >
                        {t(`quiz.kinds.${item}`)}
                      </button>
                    ))}
                    <Button
                      type="text"
                      shape="round"
                      className="linkish"
                      disabled={start.isPending}
                      onClick={() => setTypes(["tf"])}
                    >
                      {t("quiz.tfOnly")}
                    </Button>
                  </div>
                </fieldset>
                <div className="px-quiz-timer-setup">
                  <label className="px-quiz-toggle">
                    <input
                      type="checkbox"
                      checked={timerOn}
                      disabled={start.isPending}
                      onChange={(event) => setTimerOn(event.target.checked)}
                    />
                    <span>{t("quiz.timerOption")}</span>
                  </label>
                  {timerOn ? (
                    <label className="px-quiz-field">
                      <span className="small">{t("quiz.timerMinutes")}</span>
                      <InputNumber
                        min={1}
                        max={180}
                        precision={0}
                        value={timerMinutes}
                        onChange={setTimerMinutes}
                        disabled={start.isPending}
                      />
                    </label>
                  ) : null}
                </div>
              </>
            )
          }
        />
      ) : !questions.length && !diagnostic && attemptId ? (
        <section className="px-quiz-wait">
          <StepLines
            label={t("quiz.preparing")}
            steps={[
              {
                id: "questions",
                label: t("quiz.preparing"),
                state: generationFailed ? "failed" : "running",
              },
            ]}
          />
        </section>
      ) : finalResult ? (
        <QuizResults
          diagnostic={diagnostic && !review}
          questions={questions}
          results={finalResult.results}
          score={finalResult.score}
          topics={plan.data?.topics ?? []}
          answerText={answerText}
          expectedText={expectedText}
          onAsk={(row) => void ask(row)}
          onWrong={(row, wrong) =>
            markWrong.mutate({ questionId: row.id, wrong })
          }
          wrongBusy={markWrong.isPending ? markWrong.variables?.questionId : undefined}
          actions={
            <>
              <ExportButton
                planId={planId ?? ""}
                topicId={topicId}
                kind="quiz"
                attemptId={attemptId || undefined}
              />
              <span className="px-quiz-footer-main">
                {!review &&
                finalResult.results.some((row) => !row.flagged && row.score < 1) ? (
                  <Button
                    shape="round"
                    size="large"
                    onClick={() => navigate(`/plans/${planId ?? ""}/review`)}
                  >
                    {t("quiz.reviewMistakes")}
                  </Button>
                ) : null}
                <Button
                  type="primary"
                  shape="round"
                  size="large"
                  onClick={() => navigate(`/plans/${planId ?? ""}`)}
                >
                  {t("quiz.continue")}
                </Button>
              </span>
            </>
          }
        />
      ) : gradingStarted ? (
        <section className="px-quiz-wait" aria-busy={!gradingStopped}>
          <p className="title-3">{t("quiz.gradingTitle")}</p>
          <StepLines
            label={t("quiz.gradingTitle")}
            steps={[
              {
                id: "grading",
                label: grading.data?.total
                  ? t("quiz.gradingProgress", {
                      done: grading.data.done,
                      total: grading.data.total,
                      count: grading.data.total,
                    })
                  : t("quiz.gradingTitle"),
                state: gradingStopped ? "failed" : "running",
              },
            ]}
          />
          {!(gradingStopped && grading.data?.error) ? (
            <p className="small" role={gradingStopped ? "alert" : "status"}>
              {t(
                !gradingStopped
                  ? "quiz.gradingSaved"
                  : gradeState === "cancelled"
                    ? "quiz.gradingCancelled"
                    : "quiz.gradingStopped",
              )}
            </p>
          ) : null}
          {gradingStopped && grading.data?.error ? (
            <Notice tone="danger" details={grading.data.error.slice(0, 2000)}>
              {t("quiz.gradingStopped")}
            </Notice>
          ) : null}
          {grading.data?.model ? (
            <p className="meta">
              {t("quiz.gradedBy", { model: grading.data.model })}
            </p>
          ) : null}
          <div className="px-quiz-nav">
            {gradingStopped && gradeState !== "cancelled" ? (
              <Button shape="round" onClick={() => navigate("/settings/engines")}>
                {t("engines.title")}
              </Button>
            ) : (
              <span />
            )}
            {gradingStopped ? (
              <Button
                type="primary"
                shape="round"
                loading={control.isPending}
                onClick={() =>
                  control.mutate(
                    gradeState === "interrupted" ? "jobs.resume" : "jobs.retry",
                  )
                }
              >
                {t(
                  gradeState === "interrupted"
                    ? "quiz.gradeResume"
                    : "quiz.gradeRetry",
                )}
              </Button>
            ) : (
              <Button
                shape="round"
                disabled={!grading.data?.jobId || control.isPending}
                onClick={() => control.mutate("jobs.cancel")}
              >
                {t("quiz.gradeCancel")}
              </Button>
            )}
          </div>
        </section>
      ) : question ? (
        <section className="px-quiz-question" aria-labelledby="quiz-stem">
          {msLeft !== undefined ? (
            <div className="px-quiz-timer">
              <output role="timer" aria-label={t("quiz.timer")}>
                {clock(msLeft)}
              </output>
              {expired || msLeft <= 60000 ? (
                <p className="small" role="status">
                  {t(expired ? "quiz.timeUp" : "quiz.timeLow")}
                </p>
              ) : null}
            </div>
          ) : null}
          {index === 0 && drillNotes.length ? (
            <section className="px-quiz-explain" aria-labelledby="quiz-explain">
              <h2 id="quiz-explain" className="label">
                {t("quiz.drillExplanation")}
              </h2>
              {drillNotes.map((note) => (
                <MarkdownView key={note}>{note}</MarkdownView>
              ))}
            </section>
          ) : null}
          <div className="px-quiz-kicker">
            <span className="label">{t(`quiz.kinds.${kind}`, { defaultValue: "" })}</span>
            {session.data?.general ? (
              <Tag tone="general">{t("components.tags.general")}</Tag>
            ) : null}
          </div>
          <div
            ref={heading}
            id="quiz-stem"
            tabIndex={-1}
            className="px-quiz-stem"
          >
            <MarkdownView>{stemText(question.stem)}</MarkdownView>
          </div>
          {kind === "tf" && !result ? (
            <div className="px-quiz-soft-time">
              <div
                className="px-quiz-soft-track"
                role="progressbar"
                aria-label={t("quiz.softTimer")}
                aria-valuemin={0}
                aria-valuemax={10}
                aria-valuenow={Math.ceil(remaining)}
              >
                <span style={{ width: `${remaining * 10}%` }} />
              </div>
              <p className="meta">{t("quiz.softHint")}</p>
            </div>
          ) : null}
          {kind === "mcq" || kind === "tf" ? (
            <div className="px-quiz-options-list">
              {options.map((option, optionIndex) => (
                <QuizOption
                  key={optionIndex}
                  letter={String.fromCharCode(65 + optionIndex)}
                  state={optionState(valueOf(optionIndex))}
                  shortcut={optionIndex < 4 ? String(optionIndex + 1) : undefined}
                  label={`${String.fromCharCode(65 + optionIndex)}. ${option.replace(/\$/g, "")}`}
                  disabled={locked}
                  onClick={() => pick(valueOf(optionIndex))}
                >
                  <InlineMarkdown>{option}</InlineMarkdown>
                </QuizOption>
              ))}
            </div>
          ) : kind === "matching" ? (
            <div className="px-quiz-matching">
              {question.left?.map((left, leftIndex) => (
                <label key={leftIndex}>
                  <InlineMarkdown>{left}</InlineMarkdown>
                  <select
                    aria-label={t("quiz.matchFor", { item: left })}
                    disabled={locked}
                    value={pairs(picks[question.id])[leftIndex]?.[1] ?? ""}
                    onChange={(event) =>
                      pick(
                        JSON.stringify(
                          (question.left ?? []).map((item, itemIndex) => [
                            item,
                            itemIndex === leftIndex
                              ? event.target.value
                              : (pairs(picks[question.id])[itemIndex]?.[1] ??
                                ""),
                          ]),
                        ),
                      )
                    }
                  >
                    <option value="">{t("quiz.chooseMatch")}</option>
                    {question.right?.map((right, rightIndex) => (
                      <option key={rightIndex} value={right}>
                        {right}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          ) : kind === "completion" ? (
            <div className="px-quiz-blanks">
              {Array.from({ length: blankCount }, (_, blankIndex) => (
                <label key={blankIndex}>
                  <span className="small">
                    {t("quiz.blank", { index: blankIndex + 1 })}
                  </span>
                  <Input
                    disabled={locked}
                    value={blanks(picks[question.id])[blankIndex] ?? ""}
                    onChange={(event) => {
                      const values = blanks(picks[question.id]);
                      values[blankIndex] = event.target.value;
                      pick(JSON.stringify(values));
                    }}
                  />
                </label>
              ))}
            </div>
          ) : (
            <div className="px-quiz-open">
              <MathInput
                ariaLabel={t("quiz.yourAnswer")}
                rows={6}
                disabled={locked}
                value={picks[question.id] ?? ""}
                onChange={pick}
              />
            </div>
          )}
          {checking === question.id && kind === "open" ? (
            <div className="px-quiz-checking" role="status">
              <Icon name="loader-circle" size={16} className="px-spin" />
              <span className="body">{t("quiz.checking")}</span>
              <Button type="text" shape="round" size="small" onClick={stopCheck}>
                {t("quiz.checkCancel")}
              </Button>
            </div>
          ) : null}
          {checkFailed ? (
            <Notice
              tone="danger"
              action={{ label: t("quiz.checkRetry"), onClick: runCheck }}
            >
              {t("quiz.checkFailed")}
            </Notice>
          ) : null}
          {result ? (
            <Feedback
              result={result}
              kind={kind ?? "open"}
              expected={expectedText(result)}
              wrong={wrongMarked}
              busy={markWrong.isPending}
              onAsk={() => void ask(result)}
              onWrong={(wrong) =>
                markWrong.mutate({ questionId: question.id, wrong })
              }
            />
          ) : null}
          <div className="px-quiz-nav">
            {index > 0 ? (
              <Button
                shape="round"
                size="large"
                disabled={Boolean(checking)}
                onClick={() => goTo(index - 1)}
              >
                {t("nav.back")}
              </Button>
            ) : (
              <span />
            )}
            <Button
              key={primary.key}
              autoFocus={primary.key === "next" || primary.key === "results"}
              type="primary"
              shape="round"
              size="large"
              loading={primary.loading}
              disabled={primary.disabled}
              onClick={primary.onClick}
            >
              {primary.label}
            </Button>
          </div>
        </section>
      ) : (
        <p className="small">{t("quiz.empty")}</p>
      )}
      {error ? (
        <p className="small" role="alert">
          {t(errorKey, { defaultValue: t("quiz.error") })}
        </p>
      ) : null}
    </FocusLayout>
  );
}

/** The correction shown right after Check: verdict, the right answer when it is not on screen, and why. */
function Feedback({
  result,
  kind,
  expected,
  wrong,
  busy,
  onAsk,
  onWrong,
}: {
  result: QuizAnswer;
  kind: string;
  expected: string;
  wrong: boolean;
  busy: boolean;
  onAsk: () => void;
  onWrong: (wrong: boolean) => void;
}) {
  const { t } = useTranslation();
  const state = verdict(result.score);
  const closed = kind === "mcq" || kind === "tf";
  return (
    <div className={`px-quiz-feedback is-${state}`} role="status">
      <p className="px-quiz-verdict">
        <Icon
          name={
            state === "correct"
              ? "circle-check"
              : state === "partial"
                ? "circle-alert"
                : "circle-x"
          }
          size={20}
          strokeWidth={2}
        />
        <span className="title-3">
          {t(
            state === "correct"
              ? "quiz.correct"
              : state === "partial"
                ? "quiz.partial"
                : "quiz.incorrect",
          )}
        </span>
        {state === "partial" ? (
          <span className="meta">{Math.round(result.score * 100)}%</span>
        ) : null}
      </p>
      {!closed && result.score < 1 && expected ? (
        <div className="px-quiz-answer is-expected">
          <p className="label">
            {t(kind === "open" ? "quiz.reference" : "quiz.expected")}
          </p>
          <MarkdownView variant="body">{expected}</MarkdownView>
        </div>
      ) : null}
      {result.explanation ? (
        <MarkdownView
          variant="body"
          citationResolver={(n) => result.citations[n - 1]?.label}
          onCitationClick={(n) => {
            const cite = result.citations[n - 1];
            if (cite) openSourceViewer({ passageId: cite.passageId });
          }}
        >
          {result.explanation}
        </MarkdownView>
      ) : null}
      {result.model ? (
        <p className="meta px-quiz-graded">
          {t("quiz.gradedBy", { model: result.model })}
        </p>
      ) : null}
      <div className="px-quiz-feedback-actions">
        {result.score < 1 ? (
          <Button type="text" shape="round" size="small" onClick={onAsk}>
            {t("ask.askTutor")}
          </Button>
        ) : null}
        {wrong ? (
          <>
            <span className="small px-quiz-flag-note">{t("quiz.wrongDone")}</span>
            <Button
              type="text"
              shape="round"
              size="small"
              disabled={busy}
              onClick={() => onWrong(false)}
            >
              {t("quiz.wrongUndo")}
            </Button>
          </>
        ) : (
          <Button
            type="text"
            shape="round"
            size="small"
            className="px-quiz-wrong"
            icon={<Icon name="flag" size={14} />}
            disabled={busy}
            onClick={() => onWrong(true)}
          >
            {t("quiz.wrongQuestion")}
          </Button>
        )}
      </div>
    </div>
  );
}
