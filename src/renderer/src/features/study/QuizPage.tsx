import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, InputNumber, Select } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { QUIZ_MAX_QUESTIONS, quizMinutes } from "@shared/quiz";
import { spokenText } from "@shared/spoken-math";
import { ErrorState } from "../../components/ErrorState";
import { Notice } from "../../components/Notice";
import { QuizOption, type QuizOptionState } from "../../components/QuizOption";
import { StepLines } from "../../components/StepLines";
import { Tag } from "../../components/Tag";
import { InlineMarkdown } from "../../components/InlineMarkdown";
import { MathInput } from "../../components/MathInput";
import { MarkdownView } from "../../components/MarkdownView";
import { ExportButton } from "../share/ExportButton";
import { errorDetails } from "../../lib/errorDetails";
import { errorProvider, useEngineError } from "../../lib/engineError";
import { useEngineNames } from "../../lib/useEngineNames";
import { jobErrorEngine, jobErrorKey } from "../jobs/jobErrors";
import { invoke } from "../../lib/ipc";
import { useStillHere } from "../../lib/useStillHere";
import { useActiveTime } from "./activeTime";
import { useDeadlinePassed, useNow } from "./clock";
import { useDraftSaver } from "./draftSaver";
import { useReviewSession } from "./ReviewProgress";
import { useMenuLock } from "../../app/menu-state";
import { ActivityChoice, ActivityIntro, type ActivityFact } from "./ActivityIntro";
import { ResultsScreen, type ResultItem, type ResultTopic } from "./ResultsScreen";
import { StudyLayout } from "./StudyBar";
import { returnTo, usePlace } from "../../app/usePlace";
import { HandInConfirm, QuizColumn, type HandInFrom } from "./QuizColumn";
import { Button as PxButton } from "../../components/Button";
import { SkeletonRows } from "../../components/Skeleton";
import {
  dontKnowPicks,
  editedPicks,
  given,
  handInCount,
  handInPicks,
  restoredMarked,
  toggleMarked,
} from "./quizSheet";
import {
  answerSource,
  blanks,
  pairs,
  quizBack,
  quizBackLabel,
  skipOrder,
  stemText,
  questionPoints,
  verdict,
  verdictLine,
  type QuizAnswer,
} from "./quizText";
import "./QuizPage.css";
import { pastPapersQuery, usePlan, useSources } from "../../lib/queries";
import { Logo } from "../../components/Logo";
import { Working } from "../../components/Working";

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
      <output role="timer" aria-label={t("quiz.timer")} className={msLeft <= 60000 ? "is-low" : undefined}>
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

/**
 * `redo`: notebook questions asked again; the attempt comes in the URL and closing goes back to the notebook.
 * `review`: the questions of a mixed Review, at /plans/:planId/review/questions; the Review page starts the attempt.
 */
export function QuizPage({ redo = false, review: reviewRoute = false }: { redo?: boolean; review?: boolean }) {
  const { t, i18n } = useTranslation();
  const engineNames = useEngineNames();
  const { message } = App.useApp();
  const { planId, topicId } = useParams();
  useActiveTime(planId, topicId ?? null);
  const navigate = useNavigate();
  const describeEngineError = useEngineError();
  // Past questions: a quiz of the plan's past exam questions, opened at /plans/:planId/past.
  const past = useLocation().pathname.endsWith("/past");
  const diagnostic = !topicId && !redo && !past && !reviewRoute;
  // A diagnostic and a Review save every question when they start; a quiz is written by a build job meanwhile.
  const fixed = diagnostic || reviewRoute;
  const [searchParams, setSearchParams] = useSearchParams();
  const stillHere = useStillHere();
  const paper = searchParams.get("paper") ?? undefined;
  const savedAttempt = searchParams.get("attempt");
  // The mistakes notebook lives only under Exams; a redo returns to it narrowed to the exam it was narrowed to.
  const notebookExam = searchParams.get("exam");
  const backPath = quizBack({ planId, redo, review: reviewRoute, notebookExam });
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
  // Answers corrected one by one before 0.5, read back with the attempt: they stay as they were checked.
  const [checked, setChecked] = useState<Record<string, QuizAnswer>>({});
  const [wrongMarks, setWrongMarks] = useState<Record<string, boolean>>({});
  // An attempt handed in before 0.5 with skipped questions numbers its results in the order the student met them.
  const [skipped, setSkipped] = useState<string[]>([]);
  // Questions marked "Segna per dopo", in question order; saved with the draft.
  const [marked, setMarked] = useState<string[]>([]);
  // The Consegna question, open under the button that asked it.
  const [confirmFrom, setConfirmFrom] = useState<HandInFrom | null>(null);
  const [actionError, setActionError] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const card = useRef<HTMLElement>(null);
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
      // The quiz was started a moment ago; the student may have left since, and the address is then another page's.
      if (session.attemptId && stillHere())
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
  const review = reviewRoute || Boolean(session.data?.review);
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
  const requestedCount = fixed
    ? questions.length
    : (session.data?.requestedCount ?? QUIZ_MAX_QUESTIONS);
  const generationFailed = Boolean(
    session.data &&
    ["failed", "cancelled", "interrupted"].includes(session.data.state),
  );
  const generating =
    !fixed &&
    Boolean(attemptId) &&
    !generationFailed &&
    session.data?.state !== "succeeded";
  // Until the queue answers, a review does not know yet how many drill questions it still owes.
  const queueLoading = review && reviewQueue.isLoading;
  const canFinish =
    (fixed && !queueLoading && owed === 0) ||
    (!fixed && session.data?.state === "succeeded" && questions.length >= requestedCount);
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
    // A quiz opened again restores from a read made now: the cached one is from when the page last opened, before the
    // answers and the question the student left on were saved.
    if (restoring && !session.isFetchedAfterMount) return;
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
      const draft = session.data.draft;
      const asked = session.data.questions.map((row) => ({ id: row.id, kind: row.grade.kind }));
      const handedIn = session.data.submittedAt != null;
      setSkipped(handedIn ? (draft?.skipped ?? []) : []);
      setMarked(handedIn ? [] : restoredMarked(draft, asked));
      // A quiz left halfway opens where it was left, or on the first question with nothing given.
      const saved = { ...draft?.picks, ...Object.fromEntries(session.data.checked.map((row) => [row.id, row.pick])) };
      const firstBlank = asked.findIndex((row) => given(row.kind, saved[row.id]) === "none");
      // A draft from before 0.5 counted its place in the order with skipped questions moved last.
      const left = draft?.skipped?.length && !draft.marked
        ? skipOrder(asked, draft.skipped)[draft.index]?.id
        : undefined;
      const leftAt = left ? asked.findIndex((row) => row.id === left) : -1;
      setIndex(
        Math.min(
          Math.max(0, leftAt >= 0 ? leftAt : (draft?.index ?? (firstBlank < 0 ? asked.length - 1 : firstBlank))),
          Math.max(0, asked.length - 1),
        ),
      );
      setHydratedAttempt(attemptId);
    }
  }, [session.data, session.isFetchedAfterMount, attemptId]);
  // The results of an attempt handed in before 0.5 follow the order its questions were met in; the quiz itself asks
  // them in their own order, as the Domande card numbers them.
  const ordered = skipOrder(questions, skipped);
  const question = questions[index];
  const asked = questions.map((row) => ({ id: row.id, kind: row.grade.kind }));
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
  // Consegna hands in every question: a blank one goes as an empty pick, which counts as "Non lo so".
  const submit = useMutation({
    mutationFn: () =>
      invoke("study.quizSubmit", {
        attemptId,
        picks: handInPicks(asked, picks),
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
  // Each answer the grading job finishes is saved as a check; reading the session again shows it while the rest wait.
  const gradedSoFar = grading.data?.done;
  useEffect(() => {
    if (gradedSoFar) void session.refetch();
  }, [gradedSoFar]);
  const gradingStopped = ["failed", "cancelled", "interrupted"].includes(
    gradeState,
  );
  // Grading that stopped on a refused sign-in names the engine and offers its sign-in.
  const gradingFailure = grading.data?.error
    ? describeEngineError(
        jobErrorKey(grading.data.error),
        jobErrorEngine(grading.data.error),
      )
    : undefined;
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
      marked: string[];
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
      drafts.schedule({ attemptId, planId, picks, index, marked });
    else drafts.cancel();
  }, [
    attemptId,
    hydratedAttempt,
    picks,
    index,
    marked,
    finalResult,
    gradingStarted,
    expired,
    canFinish,
    session.data?.submittedAt,
  ]);
  // The page goes by its topic elsewhere. Leaving it never loses work: the answers are saved first, and a save that
  // fails keeps the student here, under the page's notice that saving failed.
  const topicName = topicId ? plan.data?.topics.find((row) => row.id === topicId)?.title : undefined;
  const back = usePlace({
    name: topicName ? { text: topicName } : null,
    parent: plan.data && !reviewRoute ? { name: { text: plan.data.title } } : undefined,
    beforeLeave: () => drafts.flush(),
  });
  async function close() {
    if (await drafts.flush()) returnTo(back, backPath, navigate);
  }
  // An answer corrected one by one before 0.5 stays as it was checked: core keeps the checked pick at Consegna.
  const result = question ? checked[question.id] : undefined;
  const locked =
    Boolean(result) ||
    submit.isPending ||
    gradingStarted ||
    expired ||
    // A timed quiz's clock starts once every question exists; until then it takes no answers.
    (timed && session.data?.state !== "succeeded") ||
    (Boolean(attemptId) && hydratedAttempt !== attemptId);
  // A new question takes focus, so a screen reader reads its position and its text; the card shows no focus box.
  // The card mounts once the attempt is restored, so its first focus waits for that.
  useEffect(() => {
    if (question) card.current?.focus({ preventScroll: true });
  }, [question?.id, hydratedAttempt]);
  function pick(value: string) {
    if (question && !locked) setPicks((current) => editedPicks(current, question.id, question.grade.kind, value));
  }
  function goTo(next: number) {
    setConfirmFrom(null);
    setIndex(next);
  }
  // "Non lo so" gives an empty answer, scored 0 with the right answer shown in the results; pressed again, it is taken back.
  function dontKnow() {
    if (question && !locked) setPicks((current) => dontKnowPicks(current, question.id));
  }
  function mark() {
    if (!question || submit.isPending || gradingStarted) return;
    setMarked((current) => toggleMarked(current, question.id, questions.map((row) => row.id)));
  }
  const handIn = handInCount(asked, picks, marked);
  function requestHandIn(from: HandInFrom) {
    if (!canFinish || gradingStarted || submit.isPending) return;
    if (handIn.blank || handIn.marked) setConfirmFrom(from);
    else submit.mutate();
  }
  function cancelHandIn() {
    const from = confirmFrom;
    setConfirmFrom(null);
    // Focus goes back to the Consegna that asked.
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(from === "nav" ? ".px-qz-nav .px-btn-primary" : ".px-qz-handin > .px-btn")
        ?.focus(),
    );
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
  const queryClient = useQueryClient();
  const markWrong = useMutation({
    mutationFn: (input: { questionId: string; wrong: boolean }) =>
      invoke("study.quizWrong", { attemptId, ...input }),
    onSuccess: (_, input) => {
      // Marking a question wrong recomputes the exam's gaps, which the results screen's change panel shows.
      void queryClient.invalidateQueries({ queryKey: ["attempt-outcome", attemptId] });
      setWrongMarks((current) => ({
        ...current,
        [input.questionId]: input.wrong,
      }));
      void session.refetch();
      void grading.refetch();
      const key = `quiz-wrong-${input.questionId}`;
      // While answering, "Segnala la domanda" stays pressed and says what it did; the toast is the results screen's.
      if (input.wrong && finalResult)
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
  const rawPick = question ? picks[question.id] : undefined;
  const blankCount = question
    ? Math.max(1, [...question.stem.matchAll(/\{\{\d+\}\}/g)].length)
    : 1;
  const lastAsked = index + 1 >= questions.length;
  // More questions are still being written after this one.
  const waitingAfter = !fixed && generating && lastAsked;
  const primary = expired
    ? {
        key: "finish",
        label: t("quiz.finish"),
        onClick: finishNow,
        disabled: !canFinish || submit.isPending,
      }
    : !lastAsked
      ? { key: "next", label: t("quiz.next"), onClick: () => goTo(index + 1), disabled: false }
      : waitingAfter || !canFinish
        ? {
            key: "wait",
            // How many are still being written, so the wait has an end the student can see.
            label:
              requestedCount > questions.length
                ? t("quiz.waitingMore", { count: requestedCount - questions.length })
                : t("quiz.waitingBatch"),
            onClick: () => undefined,
            disabled: true,
          }
        : {
            key: "handin",
            label: t("quiz.sheet.handIn"),
            onClick: () => requestHandIn("nav"),
            disabled: gradingStarted || submit.isPending,
          };
  // Keys: 1–4 pick an option, 0 says "Non lo so", S marks for later, Enter goes on. Typing in a field and real buttons
  // keep their own keys.
  const keys = useRef({ primary, pick, question, locked, dontKnow, mark });
  keys.current = { primary, pick, question, locked, dontKnow, mark };
  const answering = Boolean(question) && !finalResult && !gradingStarted && !noAnswers;
  // The menu leaves a quiz alone until it is finished.
  useMenuLock(answering);
  useEffect(() => {
    if (!answering) return;
    const onKey = (event: KeyboardEvent) => {
      const current = keys.current;
      if (event.altKey || event.repeat || event.defaultPrevented || !current.question) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("[role=dialog], .ant-drawer, .ant-select-dropdown, .px-qz-confirm")) return;
      const field = target?.closest("input, textarea, select, [contenteditable=true], .px-mathinput");
      if (event.key === "Enter") {
        if (event.shiftKey) return;
        const option = target?.closest(".px-opt");
        const control = target?.closest("button, a, summary, select, [role=button]");
        // Enter on an option not yet picked picks it, like any button.
        if (option && option.getAttribute("aria-pressed") !== "true") return;
        if (control && !option) return;
        const singleLine = target instanceof HTMLInputElement && target.type === "text";
        if (field && !singleLine && !(event.ctrlKey || event.metaKey)) return;
        if (current.primary.disabled) return;
        event.preventDefault();
        current.primary.onClick();
        return;
      }
      if (event.ctrlKey || event.metaKey || field) return;
      if (event.key === "s" || event.key === "S") {
        event.preventDefault();
        current.mark();
        return;
      }
      if (current.locked) return;
      if (event.key === "0") {
        event.preventDefault();
        current.dontKnow();
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
  // A refused sign-in names its engine and offers its sign-in.
  const engineFailure = error
    ? describeEngineError(errorKey, errorProvider(error))
    : undefined;
  // A mixed review counts its cards and questions as one queue, so the position and bar cover both.
  const wholeReview =
    session.data?.review && reviewQueue.data
      ? reviewQueue.data.progress
      : undefined;
  const answered = questions.filter((row) => checked[row.id]).length;
  const topic = plan.data?.topics.find((row) => row.id === topicId);
  const showIntro = !start.data && !savedAttempt;
  // A question is on screen and being answered: the bar counts it.
  const inQuestions = Boolean(question) && !finalResult && !showIntro && !noAnswers && !gradingStarted;
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
  const introTopics = diagnostic ? (preview.data?.topics ?? 0) : 0;
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
  // Answers are graded at Consegna, so an option is only chosen or not until the results.
  function optionState(value: string): QuizOptionState {
    return rawPick === value ? "selected" : "idle";
  }
  // A failed preparation sits under the step it stopped at, or above the questions that did arrive. A refused sign-in
  // names its engine and offers its sign-in.
  const buildFailure = session.data?.error
    ? describeEngineError(
        jobErrorKey(session.data.error),
        jobErrorEngine(session.data.error),
      )
    : undefined;
  const buildFailed = generationFailed ? (
    <ErrorState
      secondary={buildFailure?.action}
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
      {buildFailure?.action ? ` ${buildFailure.text}` : null}
    </ErrorState>
  ) : null;
  // The results screen: the score counts every answer not marked wrong by the student.
  const points = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const countedResults = finalResult?.results.filter((row) => !row.flagged) ?? [];
  const resultPoints = countedResults.reduce((sum, row) => sum + row.score, 0);
  const excludedResults = (finalResult?.results.length ?? 0) - countedResults.length;
  const hasMistakes = !review && !redo && countedResults.some((row) => row.score < 1);
  // A finished Review goes on to the exam: its own page is where a review in progress is resumed, not where one ends.
  const finishedReview = Boolean(finalResult) && reviewRoute;
  const backButton = (type: "primary" | "default") => (
    <Button
      type={type}
      shape="round"
      size="large"
      onClick={() => returnTo(back, finishedReview ? quizBack({ planId, notebookExam }) : backPath, navigate)}
    >
      {t(
        finishedReview
          ? reopened
            ? quizBackLabel({})
            : "quiz.continue"
          : reopened || redo
            ? quizBackLabel({ redo, review: reviewRoute })
            : "quiz.continue",
      )}
    </Button>
  );
  // Only the saved session knows each question's topic; a quiz just started has not read it back yet.
  const topicOf = (id: string) =>
    session.data?.questions.find((item) => item.id === id)?.topicId;
  const topicTitle = (id: string) =>
    plan.data?.topics.find((entry) => entry.id === topicOf(id))?.title;
  // Each topic's points, in the plan's order. A quiz on one topic has nothing to compare, so it shows none.
  const quizTopics: ResultTopic[] = (() => {
    if (!finalResult) return [];
    const rows = (plan.data?.topics ?? []).flatMap((row) => {
      const answers = countedResults.filter(
        (answer) => topicOf(answer.id) === row.id,
      );
      if (!answers.length) return [];
      const value = answers.reduce((sum, answer) => sum + answer.score, 0);
      const share = value / answers.length;
      const level = share >= 0.8 ? "solid" : share >= 0.5 ? "review" : "start";
      return [
        {
          id: row.id,
          title: row.title,
          share,
          value: t("quiz.topicScore", { points: points.format(value), total: answers.length }),
          ...(diagnostic && !review ? { level: t(`quiz.topicLevel.${level}`) } : {}),
        },
      ];
    });
    return diagnostic && !review ? rows : rows.length > 1 ? rows : [];
  })();
  const resultItem = (
    row: QuizAnswer,
    mark: ResultItem["mark"],
  ): ResultItem => {
    const item = questions.find((entry) => entry.id === row.id);
    const graded = checked[row.id];
    const long = item?.grade.kind === "open";
    return {
      id: row.id,
      stem: item?.stem ?? "",
      topic: topicTitle(row.id),
      mark,
      value: row.score,
      ...(mark === "partial" ? { score: t("quiz.questionPoints", { points: questionPoints(row.score, i18n.language) }) } : {}),
      answer: answerText(row.id),
      typed: answerSource(item?.grade.kind ?? ""),
      long,
      expected: expectedText(row),
      expectedLabel: t(long ? "quiz.reference" : "results.rightAnswer"),
      explanation: row.explanation,
      citations: row.citations,
      grader:
        graded?.model || row.model
          ? engineNames.label(
              graded?.model ? graded.provider : row.provider,
              graded?.model ?? row.model,
            )
          : undefined,
      onAsk: () => void ask(row),
      ...(finalResult
        ? {
            wrong: {
              busy: markWrong.isPending && markWrong.variables?.questionId === row.id,
              onChange: (wrong: boolean) => markWrong.mutate({ questionId: row.id, wrong }),
            },
          }
        : {}),
    };
  };
  // Numbered as the student met them: a skipped question is listed where it came back, not where it was stored.
  // While grading runs, answers already graded read in full and the others say whether they are next or waiting.
  const quizItems: ResultItem[] = finalResult
    ? skipOrder(finalResult.results, skipped).map((row) =>
        resultItem(row, row.flagged ? "flagged" : verdict(row.score)),
      )
    : ordered.map((item) => {
        const queue = grading.data?.pending ?? [];
        const place = queue.indexOf(item.id);
        const done = grading.data?.done ?? 0;
        const graded = checked[item.id];
        if (graded && (place < 0 || place < done))
          return resultItem(graded, verdict(graded.score));
        // Not in the grading job's list (an unanswered question when the time ran out): nothing will grade it. Until the
        // job exists and its list has loaded, every answer still reads as queued.
        const outOfJob = grading.data?.jobId != null && place < 0;
        const mark: ResultItem["mark"] = gradingStopped || outOfJob
          ? "ungraded"
          : place === done
            ? "grading"
            : "queued";
        return {
          id: item.id,
          stem: item.stem,
          topic: topicTitle(item.id),
          mark,
          answer: answerText(item.id),
          typed: answerSource(item.grade.kind),
          long: item.grade.kind === "open",
          expectedLabel: t("quiz.expected"),
        };
      });
  // The answer sheet around one card: the Domande card beside it, Indietro and Avanti under it.
  function answerSheet(content: ReactNode) {
    const waiting = loadingAttempt || fixed || !generating ? 0 : Math.max(0, requestedCount - questions.length);
    return (
      <QuizColumn
        loading={loadingAttempt}
        items={questions.map((row) => ({
          id: row.id,
          given: given(row.grade.kind, picks[row.id]),
          marked: marked.includes(row.id),
        }))}
        current={index}
        waiting={waiting}
        onJump={goTo}
        busyLine={
          generating && questions.length
            ? t("quiz.available", { available: questions.length, total: requestedCount, count: requestedCount })
            : undefined
        }
        handIn={{
          disabled: !canFinish || gradingStarted || submit.isPending || loadingAttempt,
          note:
            generating && timed
              ? t("quiz.timerWaiting")
              : generating || owed > 0
                ? t("quiz.sheet.waitQuestions")
                : undefined,
          onRequest: requestHandIn,
        }}
        confirm={
          confirmFrom
            ? {
                from: confirmFrom,
                content: (
                  <HandInConfirm
                    blank={handIn.blank}
                    marked={handIn.marked}
                    busy={submit.isPending}
                    onConfirm={() => {
                      setConfirmFrom(null);
                      submit.mutate();
                    }}
                    onCancel={cancelHandIn}
                  />
                ),
              }
            : undefined
        }
        before={
          owed > 0 || (generationFailed && questions.length) || errorBox ? (
            <>
              {owed > 0 ? (
                <Notice
                  tone="info"
                  action={{
                    label: t("quiz.drillOwedOpen"),
                    onClick: () => void drafts.flush().then(() => navigate(`/plans/${planId ?? ""}/review`)),
                  }}
                >
                  {t("quiz.drillOwed", { count: owed })}
                </Notice>
              ) : null}
              {generationFailed && questions.length ? buildFailed : null}
              {errorBox}
            </>
          ) : undefined
        }
        card={content}
        nav={
          question ? (
            <>
              {index > 0 ? (
                <PxButton variant="secondary" icon="chevron-left" onClick={() => goTo(index - 1)}>
                  {t("nav.back")}
                </PxButton>
              ) : null}
              <span className="px-qz-grow" />
              <PxButton
                key={primary.key}
                size="lg"
                iconEnd={primary.key === "next" ? "chevron-right" : undefined}
                disabled={primary.disabled}
                expanded={primary.key === "handin" ? confirmFrom === "nav" : undefined}
                onClick={primary.onClick}
              >
                {primary.label}
              </PxButton>
            </>
          ) : undefined
        }
        hint={
          kind === "mcq" || kind === "tf"
            ? t("quiz.sheet.keysChoice", { last: Math.min(4, options.length) })
            : kind === "completion"
              ? t("quiz.sheet.keysEnter")
              : undefined
        }
      />
    );
  }
  // One question on its card: its position and kind, the stem, the answers, and the quiet actions under them.
  function questionCard(row: NonNullable<typeof question>) {
    const isMarked = marked.includes(row.id);
    const reported = wrongMarks[row.id] ?? false;
    const unsure = rawPick === "";
    return (
      <section
        ref={card}
        tabIndex={-1}
        className="px-qz-sheet"
        aria-labelledby="quiz-position"
        aria-describedby="quiz-stem"
      >
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
        <div className="px-qz-head">
          <h1 id="quiz-position">{t("quiz.position", { current: index + 1, total: requestedCount })}</h1>
          <span className="px-qz-kicker">{t(`quiz.kinds.${kind}`, { defaultValue: "" })}</span>
          {session.data?.general ? <Tag tone="general">{t("components.tags.general")}</Tag> : null}
        </div>
        <div id="quiz-stem" className="px-qz-stem">
          <MarkdownView>{stemText(row.stem)}</MarkdownView>
        </div>
        {kind === "tf" && !locked ? <SoftTimer key={row.id} running /> : null}
        {kind === "mcq" || kind === "tf" ? (
          <div className="px-qz-options" role="group" aria-label={t("quiz.sheet.answers")}>
            {options.map((option, optionIndex) => (
              <QuizOption
                key={optionIndex}
                plain
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
            {row.left?.map((left, leftIndex) => (
              <label key={leftIndex}>
                <InlineMarkdown>{left}</InlineMarkdown>
                <Select
                  // A native <select> menu is plain text and cannot draw the math in an option.
                  aria-label={t("quiz.matchFor", { item: spokenText(left) })}
                  className="px-quiz-match-select"
                  classNames={{ popup: { root: "px-quiz-match-popup" } }}
                  disabled={locked}
                  allowClear
                  placeholder={t("quiz.chooseMatch")}
                  value={matchIndex(row.right, pairs(picks[row.id])[leftIndex]?.[1])}
                  // The label is the plain reading for assistive technology, like a multiple-choice option's. The
                  // value is the position, so a screen reader never announces the raw TeX.
                  options={(row.right ?? []).map((right, rightIndex) => ({
                    value: rightIndex,
                    label: spokenText(right),
                    // The default hover tooltip would show the label's raw TeX.
                    title: "",
                  }))}
                  optionRender={(option) => <InlineMarkdown>{row.right?.[Number(option.value)] ?? ""}</InlineMarkdown>}
                  labelRender={({ value }) => <InlineMarkdown>{row.right?.[Number(value)] ?? ""}</InlineMarkdown>}
                  onChange={(value: number | undefined) =>
                    pick(
                      JSON.stringify(
                        (row.left ?? []).map((item, itemIndex) => [
                          item,
                          itemIndex === leftIndex
                            ? value === undefined
                              ? ""
                              : (row.right?.[value] ?? "")
                            : (pairs(picks[row.id])[itemIndex]?.[1] ?? ""),
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
                <span className="small">{t("quiz.blank", { index: blankIndex + 1 })}</span>
                <input
                  type="text"
                  className="px-qz-field"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={locked}
                  value={blanks(picks[row.id])[blankIndex] ?? ""}
                  onChange={(event) => {
                    const values = Array.from({ length: blankCount }, (_, i) => blanks(picks[row.id])[i] ?? "");
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
              value={rawPick ?? ""}
              onChange={pick}
            />
          </div>
        )}
        {result ? <p className="px-qz-said">{t("quiz.sheet.checkedBefore")}</p> : null}
        <div className="px-qz-acts">
          <PxButton
            variant="ghost"
            icon="circle-question-mark"
            pressed={unsure}
            keyShortcuts="0"
            title={t("quiz.sheet.key", { key: "0" })}
            disabled={locked}
            onClick={dontKnow}
          >
            {t("quiz.dontKnow")}
          </PxButton>
          <PxButton
            variant="ghost"
            icon="flag"
            className="is-mark"
            pressed={isMarked}
            keyShortcuts="S"
            title={t("quiz.sheet.key", { key: "S" })}
            disabled={submit.isPending || gradingStarted}
            onClick={mark}
          >
            {t("quiz.sheet.mark")}
          </PxButton>
          <PxButton
            variant="ghost"
            pressed={reported}
            disabled={markWrong.isPending}
            onClick={() => markWrong.mutate({ questionId: row.id, wrong: !reported })}
          >
            {t(reported ? "quiz.sheet.reported" : "quiz.sheet.report")}
          </PxButton>
        </div>
        {unsure || reported ? (
          <p className="px-qz-said" role="status">
            {[unsure ? t("quiz.sheet.dontKnowSaid") : "", reported ? t("quiz.wrongDone") : ""].filter(Boolean).join(" ")}
          </p>
        ) : null}
      </section>
    );
  }
  // A redo exists only as an attempt the notebook started; without one there is nothing to show.
  if (redo && !savedAttempt) return <Navigate to={backPath} replace />;
  // A Review's questions belong to the attempt its page started; without one, that page starts or resumes it.
  if (reviewRoute && !savedAttempt) return <Navigate to={`/plans/${planId ?? ""}/review`} replace />;
  // The answer sheet: an attempt being read from this computer, its questions still being written, or answered.
  // Until the attempt is restored from a fresh read its answers are not known, so the sheet shows its shape. A
  // diagnostic or a Review started here already has its questions and no answers yet.
  const loadingAttempt = Boolean(attemptId) && hydratedAttempt !== attemptId && !(fixed && start.data);
  const writing = !questions.length && !fixed && Boolean(attemptId);
  const sheet =
    !showIntro && !noAnswers && !finalResult && !gradingStarted && (loadingAttempt || writing || Boolean(question));
  const errorBox = error ? (
    <ErrorState details={errorDetails(error)} action={engineFailure?.action}>
      {engineFailure?.action ? engineFailure.text : t(errorKey, { defaultValue: t("quiz.error") })}
    </ErrorState>
  ) : null;
  return (
    <StudyLayout
      wide={sheet}
      // On the answer sheet the question card's "Domanda 3 di 8" is the page's heading.
      heading={!sheet}
      actions={
        sheet && deadlineAt ? <QuizClock deadlineAt={deadlineAt} running={running} expired={expired} /> : undefined
      }
      back={back}
      title={[
        // A handed-in attempt is its results.
        finalResult ? t("results.title") : "",
        redo
          ? t("mistakes.redoTitle")
          : review
            ? t("cards.reviewTitle")
            : diagnostic
              ? t("quiz.diagnosticTitle")
              : [t("quiz.title"), topic?.title].filter(Boolean).join(" \u00b7 "),
      ]
        .filter(Boolean)
        .join(" \u00b7 ")}
      subtitle={
        sheet && !wholeReview
          ? [
              plan.data?.title,
              session.data?.timerMinutes
                ? t("quiz.sheet.minutes", { count: session.data.timerMinutes })
                : t("quiz.sheet.untimed"),
            ]
              .filter(Boolean)
              .join(" \u00b7 ")
          : inQuestions
          ? wholeReview
            ? t("cards.reviewPosition", {
                current: wholeReview.cardsTotal + index + 1,
                total: wholeReview.total,
              })
            : t("quiz.position", { current: index + 1, total: requestedCount })
          : [plan.data?.subject, plan.data?.title].filter(Boolean).join(" \u00b7 ") || undefined
      }
      // The results screen, while grading or once graded, has no line: the attempt is over.
      progress={
        !questions.length || finalResult || gradingStarted
          ? undefined
          : noAnswers
            ? 1
            : wholeReview
              ? (wholeReview.cardsTotal + answered) / wholeReview.total
              : answered / Math.max(1, requestedCount)
      }
    >
      {owed > 0 && !finalResult && !sheet ? (
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
      {!sheet && !fixed && attemptId && (generating || generationFailed) ? (
        <div className="px-quiz-generation">
          {generating && questions.length ? (
            <p className="meta px-quiz-available" role="status">
              <Logo working decorative size={16} />
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
          onBack={() => back?.go()}
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
      ) : sheet && (!question || loadingAttempt) ? (
        answerSheet(
          <div className="px-qz-sheet" aria-busy={loadingAttempt || undefined}>
            {loadingAttempt ? (
              <SkeletonRows rows={4} label={t("quiz.sheet.loading")} />
            ) : generationFailed ? (
              <>
                <StepLines
                  label={t("quiz.preparing")}
                  steps={[{ id: "questions", label: t("quiz.preparingFailed"), state: "failed" }]}
                />
                {buildFailed}
              </>
            ) : (
              <Working slot line={t("quiz.preparing")} />
            )}
          </div>,
        )
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
              onClick={() => returnTo(back, backPath, navigate)}
            >
              {t(quizBackLabel({ redo, review: reviewRoute }))}
            </Button>
          </span>
        </section>
      ) : finalResult || gradingStarted ? (
        <ResultsScreen
          kind="quiz"
          attemptId={attemptId}
          planId={planId ?? ""}
          eyebrow={
            !finalResult
              ? t("results.result")
              : reopened && session.data?.submittedAt
                ? t("quiz.answeredOn", {
                    date: new Date(session.data.submittedAt).toLocaleDateString(i18n.language, {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                    }),
                  })
                : t(diagnostic && !review ? "quiz.diagnosticDone" : "quiz.resultLabel")
          }
          grade={finalResult?.score}
          headline={
            finalResult
              ? t(
                  verdictLine(
                    finalResult.score * 100,
                    diagnostic && !review,
                    plan.data ? plan.data.target * 100 : undefined,
                  ),
                )
              : t("results.gradingHeadline")
          }
          detail={
            finalResult
              ? [
                  t("results.points", {
                    count: resultPoints,
                    points: points.format(resultPoints),
                    total: countedResults.length,
                  }),
                  excludedResults
                    ? `${t("quiz.excludedCount", { count: excludedResults })}.`
                    : "",
                  // The grade is this test's, not the exam's preparation, which also counts topics not tried yet.
                  diagnostic && !review ? t("results.diagnosticScope") : "",
                ]
                  .filter(Boolean)
                  .join(" ")
              : [
                  grading.data?.total
                    ? `${t("quiz.gradingProgress", {
                        done: grading.data.done,
                        total: grading.data.total,
                        count: grading.data.total,
                      })}.`
                    : "",
                  gradingStopped ? "" : t("results.gradeLater"),
                ]
                  .filter(Boolean)
                  .join(" ")
          }
          goal={plan.data?.target}
          grading={
            finalResult
              ? undefined
              : { done: grading.data?.done ?? 0, total: grading.data?.total ?? 0 }
          }
          stopped={gradingStopped && !finalResult}
          notes={
            gradingStopped && !finalResult ? (
              grading.data?.error ? (
                <Notice
                  tone="danger"
                  details={grading.data.error.slice(0, 2000)}
                  action={gradingFailure?.action}
                >
                  {gradingFailure?.action
                    ? `${t("quiz.gradingStopped")} ${gradingFailure.text}`
                    : t("quiz.gradingStopped")}
                </Notice>
              ) : (
                <Notice tone="danger">
                  {t(gradeState === "cancelled" ? "quiz.gradingCancelled" : "quiz.gradingStopped")}
                </Notice>
              )
            ) : undefined
          }
          topics={quizTopics}
          topicsLabel={t(diagnostic && !review ? "quiz.startHere" : "results.byTopic")}
          primary={
            !finalResult ? (
              gradingStopped ? (
                <Button
                  type="primary"
                  shape="round"
                  size="large"
                  loading={control.isPending}
                  onClick={() =>
                    control.mutate(gradeState === "interrupted" ? "jobs.resume" : "jobs.retry")
                  }
                >
                  {t("quiz.gradeResume")}
                </Button>
              ) : (
                <Button type="primary" shape="round" size="large" onClick={() => void close()}>
                  {t(quizBackLabel({ redo, review: reviewRoute }))}
                </Button>
              )
            ) : hasMistakes ? undefined : (
              backButton("primary")
            )
          }
          // Ripasso mirato: a drill on the gap this quiz opened, or this quiz's wrong answers asked again.
          review={
            finalResult && hasMistakes
              ? {
                  count: countedResults.filter((row) => row.score < 1).length,
                  onReview: () => navigate(`/plans/${planId ?? ""}/review?from=${encodeURIComponent(attemptId)}`),
                }
              : undefined
          }
          secondary={
            !finalResult ? (
              gradingStopped ? (
                <>
                  {gradeState !== "cancelled" ? (
                    <Button shape="round" size="large" onClick={() => navigate("/settings/engines")}>
                      {t("quiz.openEngines")}
                    </Button>
                  ) : null}
                  <Button type="text" shape="round" onClick={() => void close()}>
                    {t(quizBackLabel({ redo, review: reviewRoute }))}
                  </Button>
                </>
              ) : (
                <Button
                  type="text"
                  shape="round"
                  disabled={!grading.data?.jobId || control.isPending}
                  onClick={() => control.mutate("jobs.cancel")}
                >
                  {t("quiz.gradeCancel")}
                </Button>
              )
            ) : hasMistakes ? (
              backButton("default")
            ) : undefined
          }
          extra={
            finalResult ? (
              <>
                <Button type="text" shape="round" onClick={() => setExportOpen(true)}>
                  {t("export.title")}
                </Button>
                <ExportButton
                  planId={planId ?? ""}
                  topicId={topicId}
                  kind="quiz"
                  attemptId={attemptId || undefined}
                  open={exportOpen}
                  onOpenChange={setExportOpen}
                />
                {reopened && !review && !redo ? (
                  // A new quiz on the same topic (a drill's topic too), or a new diagnostic; this one stays as it is.
                  <Button type="text" shape="round" onClick={() => navigate(redoPath)}>
                    {t("quiz.redo")}
                  </Button>
                ) : null}
              </>
            ) : undefined
          }
          after={!finalResult && !gradingStopped ? t("quiz.gradingSaved") : undefined}
          items={quizItems}
          listNote={
            !finalResult && grading.data?.model
              ? t("results.gradingWith", {
                  model: engineNames.label(grading.data.provider, grading.data.model),
                })
              : undefined
          }
        />
      ) : question ? (
        answerSheet(questionCard(question))
      ) : (
        <p className="small">{t("quiz.empty")}</p>
      )}
      {sheet ? null : errorBox}
    </StudyLayout>
  );
}
