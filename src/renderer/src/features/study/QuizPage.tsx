import { useMutation, useQuery } from "@tanstack/react-query";
import { App, Button, Input, InputNumber, Select } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { QUIZ_MAX_QUESTIONS, quizMinutes } from "@shared/quiz";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { Icon } from "../../components/Icon";
import { ErrorState } from "../../components/ErrorState";
import { Notice } from "../../components/Notice";
import { QuizOption, type QuizOptionState } from "../../components/QuizOption";
import { StepLines } from "../../components/StepLines";
import { Tag } from "../../components/Tag";
import { InlineMarkdown } from "../../components/InlineMarkdown";
import { MathInput } from "../../components/MathInput";
import { MarkdownView } from "../../components/MarkdownView";
import { openSourceViewer } from "../../components/SourceViewer";
import { ExportButton } from "../share/ExportButton";
import { errorDetails } from "../../lib/errorDetails";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";
import { useDeadlinePassed, useNow } from "./clock";
import { useDraftSaver } from "./draftSaver";
import { useReviewSession } from "./ReviewProgress";
import { useMenuLock } from "../../app/menu-state";
import { ActivityChoice, ActivityIntro, type ActivityFact } from "./ActivityIntro";
import { QuizResults } from "./QuizResults";
import {
  blanks,
  pairs,
  retryPick,
  skipOrder,
  stemText,
  verdict,
  type QuizAnswer,
} from "./quizText";
import "./QuizPage.css";
import { pastPapersQuery, usePlan, useSources } from "../../lib/queries";

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

/** Where a saved match sits among a matching question's right-hand texts; `undefined` for none or one no longer offered. */
function matchIndex(right: string[] | undefined, match: string | undefined): number | undefined {
  const at = match ? (right ?? []).indexOf(match) : -1;
  return at < 0 ? undefined : at;
}

/** A timed quiz's countdown. It ticks on its own, so the page re-renders only when time is up. */
function QuizClock({
  deadlineAt,
  running,
  expired,
}: {
  deadlineAt: number;
  running: boolean;
  expired: boolean;
}) {
  const { t } = useTranslation();
  const now = useNow(1000, running && !expired);
  const msLeft = expired ? 0 : Math.max(0, deadlineAt - now);
  return (
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
  );
}

const SOFT_SECONDS = 10;

/**
 * The pace a true/false question suggests: a bar that empties in ten seconds and never locks the answer. It starts
 * when it mounts, so it takes a key per question. The bar moves every 100 ms; its value changes once a second.
 */
function SoftTimer({ running }: { running: boolean }) {
  const { t } = useTranslation();
  const [deadline] = useState(() => Date.now() + SOFT_SECONDS * 1000);
  const passed = useDeadlinePassed(deadline, running);
  const now = useNow(100, running && !passed);
  const remaining = passed ? 0 : Math.max(0, (deadline - now) / 1000);
  return (
    <div className="px-quiz-soft-time">
      <div
        className="px-quiz-soft-track"
        role="progressbar"
        aria-label={t("quiz.softTimer")}
        aria-valuemin={0}
        aria-valuemax={SOFT_SECONDS}
        aria-valuenow={Math.ceil(remaining)}
      >
        <span style={{ width: `${(remaining / SOFT_SECONDS) * 100}%` }} />
      </div>
      <p className="meta">{t("quiz.softHint")}</p>
    </div>
  );
}

/** `redo`: notebook questions asked again; the attempt comes in the URL and closing goes back to the notebook. */
export function QuizPage({ redo = false }: { redo?: boolean }) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const { planId, topicId } = useParams();
  useActiveTime(planId, topicId ?? null);
  const navigate = useNavigate();
  // Past questions: a quiz of the plan's past exam questions, opened at /plans/:planId/past.
  const past = useLocation().pathname.endsWith("/past");
  const diagnostic = !topicId && !redo && !past;
  const [searchParams, setSearchParams] = useSearchParams();
  const paper = searchParams.get("paper") ?? undefined;
  const savedAttempt = searchParams.get("attempt");
  const back = !redo
    ? `/plans/${planId ?? ""}`
    : searchParams.get("from") === "exams"
      ? "/exams/mistakes"
      : `/plans/${planId ?? ""}/mistakes`;
  const restoredAttempt = useRef<string | null>(null);
  const [hydratedAttempt, setHydratedAttempt] = useState<string | null>(null);
  const [types, setTypes] = useState<Kind[]>([...KINDS]);
  const [scope, setScope] = useState<Scope>("topic");
  const [pageSource, setPageSource] = useState<string>();
  const [page, setPage] = useState<number | null>(1);
  const [timerOn, setTimerOn] = useState(false);
  const [timerMinutes, setTimerMinutes] = useState<number | null>(20);
  const plan = usePlan(planId);
  const preview = useQuery({
    queryKey: ["diagnostic-preview", planId],
    enabled: diagnostic && !savedAttempt && Boolean(planId),
    queryFn: () =>
      invoke("study.diagnosticPreview", { planId: planId ?? "" }),
  });
  const papers = useQuery({
    ...pastPapersQuery(planId ?? ""),
    enabled: past && !savedAttempt && Boolean(planId),
  });
  const library = useSources(scope === "page");
  const pageReady = scope !== "page" || (Boolean(pageSource) && Boolean(page));
  const timerReady = !timerOn || Boolean(timerMinutes);
  const [index, setIndex] = useState(0);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, QuizAnswer>>({});
  const [wrongMarks, setWrongMarks] = useState<Record<string, boolean>>({});
  // Questions the student skipped, in the order they did; they come back once, after all the others.
  const [skipped, setSkipped] = useState<string[]>([]);
  const [actionError, setActionError] = useState(false);
  const heading = useRef<HTMLDivElement>(null);
  const start = useMutation({
    mutationFn: () =>
      past
        ? invoke("study.pastPracticeStart", { planId: planId ?? "", sourceId: paper })
        : topicId
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
        setSearchParams(
          { ...(paper ? { paper } : {}), attempt: session.attemptId },
          { replace: true },
        );
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
  // Until the queue answers, a review does not know yet how many drill questions it still owes.
  const queueLoading = review && reviewQueue.isLoading;
  const canFinish =
    (diagnostic && !queueLoading && owed === 0) ||
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
      const restoredSkips = session.data.draft?.skipped ?? [];
      setSkipped(restoredSkips);
      const firstUnchecked = skipOrder(
        session.data.questions,
        restoredSkips,
      ).findIndex(
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
  const ordered = skipOrder(questions, skipped);
  const question = ordered[index];
  const pickAtFailure = useRef("");
  const check = useMutation({
    mutationFn: (input: { questionId: string; pick: string }) =>
      invoke("study.quizCheck", { attemptId, ...input }),
    onSuccess: (result, input) => {
      setChecked((current) => ({ ...current, [result.id]: result }));
      // The pick that was checked is the answer, an empty "I don't know" too.
      setPicks((current) => ({ ...current, [result.id]: input.pick }));
    },
    // The answer in the field when the check failed, so Try again can tell an edit from an untouched pick.
    onError: (_, input) => {
      pickAtFailure.current = picks[input.questionId] ?? "";
    },
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
  // An attempt handed in before this page opened (from a path step or a results link) is shown read-only for review;
  // only Redo starts a new attempt, and only that one adds a step when it is submitted.
  const reopened = Boolean(finalResult) && submit.isIdle;
  // A plan file carries which attempts were handed in, not their answers: such an attempt has nothing to review.
  const noAnswers =
    session.data?.submittedAt != null &&
    !finalResult &&
    submit.isIdle &&
    grading.isSuccess &&
    grading.data.state === "none";
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
  const running = Boolean(deadlineAt) && !finalResult && !gradingStarted;
  const expired = useDeadlinePassed(deadlineAt || undefined, running);
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
  // Answers, checks and the current question are saved as they change and when the page closes.
  const drafts = useDraftSaver(
    async (draft: {
      attemptId: string;
      planId?: string;
      picks: Record<string, string>;
      index: number;
      skipped: string[];
    }) => {
      await invoke("study.quizDraft", draft);
      // The first save after the quiz is ready starts the timer; pick up its deadline.
      if (timed && !deadlineAt && canFinish) void session.refetch();
    },
    () => setActionError(true),
  );
  useEffect(() => {
    if (
      attemptId &&
      hydratedAttempt === attemptId &&
      !finalResult &&
      !gradingStarted &&
      !expired &&
      session.data?.submittedAt == null
    )
      drafts.schedule({ attemptId, planId, picks, index, skipped });
    else drafts.cancel();
  }, [
    attemptId,
    hydratedAttempt,
    picks,
    index,
    skipped,
    finalResult,
    gradingStarted,
    expired,
    canFinish,
    session.data?.submittedAt,
  ]);
  // Closing never loses work.
  async function close() {
    await drafts.flush();
    navigate(back);
  }
  const result = question ? checked[question.id] : undefined;
  const locked =
    Boolean(result) ||
    checking === question?.id ||
    submit.isPending ||
    gradingStarted ||
    expired ||
    // A timed quiz's clock starts once every question exists; until then it takes no answers.
    (timed && session.data?.state !== "succeeded") ||
    (Boolean(attemptId) && hydratedAttempt !== attemptId);
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
  // "I don't know" checks an empty pick: scored 0, wrong evidence, answer shown.
  function dontKnow() {
    if (!question || locked) return;
    cancelledCheck.current = null;
    check.mutate({ questionId: question.id, pick: "" });
  }
  // A question can be skipped once: it moves behind the others, and when it comes back it can only be answered.
  const skippable =
    Boolean(question) &&
    !skipped.includes(question?.id ?? "") &&
    ordered.slice(index + 1).some((row) => !checked[row.id]);
  function skip() {
    if (!question || !skippable || locked || !canFinish) return;
    check.reset();
    setSkipped((current) => [...current, question.id]);
  }
  function retryCheck() {
    if (!check.variables) return;
    cancelledCheck.current = null;
    check.mutate({
      questionId: check.variables.questionId,
      pick: retryPick(check.variables.pick, pickAtFailure.current, picks[check.variables.questionId] ?? ""),
    });
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
  // Keys: 1–4 pick an option, 0 says "I don't know", S skips, Enter checks or moves on. Typing in a field and real buttons keep their own keys.
  const keys = useRef({ primary, pick, question, locked, dontKnow, skip });
  keys.current = { primary, pick, question, locked, dontKnow, skip };
  const answering = Boolean(question) && !finalResult && !gradingStarted && !noAnswers;
  // The menu leaves a quiz alone until it is finished.
  useMenuLock(answering);
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
      if (event.key === "0") {
        event.preventDefault();
        current.dontKnow();
        return;
      }
      if (event.key === "s" || event.key === "S") {
        event.preventDefault();
        current.skip();
        return;
      }
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
  // The questions the start button will ask: one paper's, or at most a quiz's ten from all of them.
  const pastCount = (() => {
    const rows = (papers.data?.papers ?? []).filter(
      (row) => row.status === "ready" && (!paper || row.sourceId === paper),
    );
    const total = rows.reduce((sum, row) => sum + row.questions, 0);
    return paper ? total : Math.min(QUIZ_MAX_QUESTIONS, total);
  })();
  // A new quiz of the same kind: on the same topic, a new diagnostic, or the same past paper again.
  const redoPath = past
    ? `/plans/${planId ?? ""}/past${paper ? `?paper=${paper}` : ""}`
    : diagnostic
      ? `/plans/${planId ?? ""}/diagnostic`
      : `/plans/${planId ?? ""}/quiz/${topicId ?? ""}`;
  // The intro's facts: how many questions, about how long, how many topics a diagnostic covers, and when it corrects.
  const introCount = past ? pastCount : diagnostic ? preview.data?.count : QUIZ_MAX_QUESTIONS;
  const introMinutes = past
    ? pastCount
      ? quizMinutes(Array.from({ length: pastCount }, () => "open"))
      : undefined
    : diagnostic
      ? preview.data?.minutes
      : types.length
        ? quizMinutes(Array.from({ length: QUIZ_MAX_QUESTIONS }, (_, i) => types[i % types.length]!))
        : undefined;
  const answeredBefore = diagnostic ? (preview.data?.answered ?? 0) : 0;
  const introTopics = diagnostic ? (plan.data?.topics.length ?? 0) : 0;
  const introFacts: ActivityFact[] = [
    ...(introCount
      ? [
          {
            icon: "list-checks" as const,
            label: answeredBefore
              ? t("quiz.factAnswered", { answered: answeredBefore, total: introCount })
              : t("quiz.factQuestions", { count: introCount }),
          },
        ]
      : []),
    ...(introMinutes
      ? [{ icon: "clock" as const, label: t("quiz.factMinutes", { count: introMinutes }) }]
      : []),
    ...(introTopics
      ? [{ icon: "book-open" as const, label: t("quiz.factTopics", { count: introTopics }) }]
      : []),
    { icon: "circle-check", label: t("quiz.factFeedback") },
  ];
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
  // A failed preparation sits under the step it stopped at, or above the questions that did arrive.
  const buildFailed = generationFailed ? (
    <ErrorState
      action={
        session.data?.jobId
          ? {
              label: t(
                session.data.state === "interrupted"
                  ? "quiz.resume"
                  : "quiz.retry",
              ),
              onClick: () => {
                if (!retry.isPending) retry.mutate();
              },
            }
          : undefined
      }
      details={session.data?.error}
    >
      {t(
        session.data?.state === "cancelled"
          ? "quiz.buildCancelled"
          : "quiz.buildFailed",
      )}
    </ErrorState>
  ) : null;
  // A redo exists only as an attempt the notebook started; without one there is nothing to show.
  if (redo && !savedAttempt) return <Navigate to={back} replace />;
  return (
    <FocusLayout
      title={t(redo ? "mistakes.redoTitle" : diagnostic ? "quiz.diagnosticTitle" : "quiz.title")}
      onClose={() => void close()}
      meta={
        question && !finalResult && !showIntro && !noAnswers && !gradingStarted
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
          ? finalResult || noAnswers
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
              void drafts.flush().then(() => navigate(`/plans/${planId ?? ""}/review`)),
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
          {generating && timed ? <p className="small ink-muted">{t("quiz.timerWaiting")}</p> : null}
          {generationFailed && questions.length ? buildFailed : null}
        </div>
      ) : null}
      {showIntro ? (
        <ActivityIntro
          eyebrow={plan.data?.title ?? t("quiz.title")}
          title={
            past
              ? t("pastPapers.practiceTitle")
              : diagnostic
                ? t("quiz.diagnostic")
                : (topic?.title ?? t("quiz.title"))
          }
          sentence={t(
            past
              ? "pastPapers.practiceIntro"
              : diagnostic
                ? "quiz.introDiagnostic"
                : "quiz.introTopic",
          )}
          facts={introFacts}
          startLabel={t(answeredBefore ? "quiz.continueAttempt" : "quiz.start")}
          starting={start.isPending}
          startingLabel={t("quiz.preparing")}
          disabled={past ? !pastCount : !diagnostic && (!types.length || !pageReady || !timerReady)}
          onStart={() => start.mutate()}
          onBack={() => navigate(`/plans/${planId ?? ""}`)}
          folded
          options={
            diagnostic || past ? undefined : (
              <>
                <ActivityChoice
                  label={t("quiz.scope")}
                  value={scope}
                  disabled={start.isPending}
                  choices={SCOPES.map((item) => ({ value: item, label: t(`quiz.scopes.${item}`) }))}
                  onChange={setScope}
                />
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
                <fieldset className="px-intro-field">
                  <legend className="body-strong">{t("quiz.types")}</legend>
                  <div className="px-intro-pills">
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
                label: t(generationFailed ? "quiz.preparingFailed" : "quiz.preparing"),
                state: generationFailed ? "failed" : "running",
              },
            ]}
          />
          {buildFailed}
        </section>
      ) : noAnswers ? (
        <section className="px-quiz-wait">
          <Notice tone="info">{t("quiz.answersNotShared")}</Notice>
          <span className="px-quiz-footer-main">
            {redo ? null : (
              <Button
                shape="round"
                size="large"
                onClick={() => navigate(redoPath)}
              >
                {t("quiz.redo")}
              </Button>
            )}
            <Button
              type="primary"
              shape="round"
              size="large"
              onClick={() => navigate(back)}
            >
              {t(redo ? "mistakes.back" : "lesson.backToPath")}
            </Button>
          </span>
        </section>
      ) : finalResult ? (
        <QuizResults
          diagnostic={diagnostic && !review}
          questions={questions}
          // Numbered as the student met them: a skipped question is listed where it came back, not where it was stored.
          results={skipOrder(finalResult.results, skipped)}
          score={finalResult.score}
          topics={plan.data?.topics ?? []}
          answerText={answerText}
          expectedText={expectedText}
          onAsk={(row) => void ask(row)}
          onWrong={(row, wrong) =>
            markWrong.mutate({ questionId: row.id, wrong })
          }
          wrongBusy={markWrong.isPending ? markWrong.variables?.questionId : undefined}
          eyebrow={
            reopened && session.data?.submittedAt
              ? t("quiz.answeredOn", {
                  date: new Date(session.data.submittedAt).toLocaleDateString(i18n.language, {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  }),
                })
              : undefined
          }
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
                !redo &&
                finalResult.results.some((row) => !row.flagged && row.score < 1) ? (
                  <Button
                    shape="round"
                    size="large"
                    onClick={() => navigate(`/plans/${planId ?? ""}/review`)}
                  >
                    {t("quiz.reviewMistakes")}
                  </Button>
                ) : null}
                {reopened && !review && !redo ? (
                  <Button
                    shape="round"
                    size="large"
                    // A new quiz on the same topic (a drill's topic too), or a new diagnostic; this one stays as it is.
                    onClick={() =>
                      navigate(redoPath)
                    }
                  >
                    {t("quiz.redo")}
                  </Button>
                ) : null}
                <Button
                  type="primary"
                  shape="round"
                  size="large"
                  onClick={() => navigate(back)}
                >
                  {t(
                    redo
                      ? "mistakes.back"
                      : reopened
                        ? "lesson.backToPath"
                        : "quiz.continue",
                  )}
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
                {t("quiz.openEngines")}
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
          {deadlineAt ? (
            <QuizClock
              deadlineAt={deadlineAt}
              running={running}
              expired={expired}
            />
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
            {skipped.includes(question.id) && !result ? (
              <span className="meta">{t("quiz.skippedNote")}</span>
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
            <SoftTimer key={question.id} running={!finalResult} />
          ) : null}
          {kind === "mcq" || kind === "tf" ? (
            <div className="px-quiz-options-list">
              {options.map((option, optionIndex) => (
                <QuizOption
                  key={optionIndex}
                  letter={String.fromCharCode(65 + optionIndex)}
                  state={optionState(valueOf(optionIndex))}
                  shortcut={optionIndex < 4 ? String(optionIndex + 1) : undefined}
                  math={option}
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
                  <Select
                    // A native <select> menu is plain text and cannot draw the math in an option.
                    aria-label={t("quiz.matchFor", { item: left.replace(/\$/g, "") })}
                    className="px-quiz-match-select"
                    classNames={{ popup: { root: "px-quiz-match-popup" } }}
                    disabled={locked}
                    allowClear
                    placeholder={t("quiz.chooseMatch")}
                    value={matchIndex(question.right, pairs(picks[question.id])[leftIndex]?.[1])}
                    // The label is the plain reading for assistive technology, like a multiple-choice option's. The
                    // value is the position, so a screen reader never announces the raw TeX.
                    options={(question.right ?? []).map((right, rightIndex) => ({
                      value: rightIndex,
                      label: right.replace(/\$/g, ""),
                      // The default hover tooltip would show the label's raw TeX.
                      title: "",
                    }))}
                    optionRender={(option) => (
                      <InlineMarkdown>{question.right?.[Number(option.value)] ?? ""}</InlineMarkdown>
                    )}
                    labelRender={({ value }) => (
                      <InlineMarkdown>{question.right?.[Number(value)] ?? ""}</InlineMarkdown>
                    )}
                    onChange={(value: number | undefined) =>
                      pick(
                        JSON.stringify(
                          (question.left ?? []).map((item, itemIndex) => [
                            item,
                            itemIndex === leftIndex
                              ? value === undefined
                                ? ""
                                : (question.right?.[value] ?? "")
                              : (pairs(picks[question.id])[itemIndex]?.[1] ??
                                ""),
                          ]),
                        ),
                      )
                    }
                  />
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
              action={{ label: t("quiz.checkRetry"), onClick: retryCheck }}
            >
              {t("quiz.checkFailed")}
            </Notice>
          ) : null}
          {!result ? (
            <div className="px-quiz-pass">
              <Button
                type="text"
                shape="round"
                size="small"
                disabled={locked}
                aria-keyshortcuts="0"
                onClick={dontKnow}
              >
                {t("quiz.dontKnow")}
                <kbd className="px-quiz-keycap" aria-hidden>
                  0
                </kbd>
              </Button>
              {skippable ? (
                <Button
                  type="text"
                  shape="round"
                  size="small"
                  disabled={locked || !canFinish}
                  aria-keyshortcuts="S"
                  onClick={skip}
                >
                  {t("quiz.skip")}
                  <kbd className="px-quiz-keycap" aria-hidden>
                    S
                  </kbd>
                </Button>
              ) : null}
            </div>
          ) : null}
          {result ? (
            <Feedback
              result={result}
              dontKnow={rawPick === ""}
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
        <ErrorState details={errorDetails(error)}>
          {t(errorKey, { defaultValue: t("quiz.error") })}
        </ErrorState>
      ) : null}
    </FocusLayout>
  );
}

/** The correction shown right after Check: verdict, the right answer when it is not on screen, and why. */
function Feedback({
  result,
  dontKnow,
  kind,
  expected,
  wrong,
  busy,
  onAsk,
  onWrong,
}: {
  result: QuizAnswer;
  /** The student said "I don't know": scored 0, with the answer shown. */
  dontKnow: boolean;
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
            dontKnow
              ? "quiz.dontKnowVerdict"
              : state === "correct"
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
      {dontKnow ? <p className="small px-quiz-dont-know">{t("quiz.dontKnowNote")}</p> : null}
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
