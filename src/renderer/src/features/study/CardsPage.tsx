import { openSourceViewer } from "../../components/SourceViewer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dropdown, Modal } from "antd";
import { Ellipsis, MessageCircleQuestion, Pencil, Undo2 } from "lucide-react";
import "./CardsPage.css";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { CitationChip } from "../../components/CitationChip";
import { Logo } from "../../components/Logo";
import { MarkdownView } from "../../components/MarkdownView";
import { ExportButton } from "../share/ExportButton";
import { errorDetails } from "../../lib/errorDetails";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";
import { ReviewProgress, useReviewSession } from "./ReviewProgress";
import { nextLearningDue, trackLearning, type LearningCards } from "./learningCards";

import { clozeAnswer, clozeQuestion, isCloze } from "../../../../core/study/cloze";
import { Notice } from "../../components/Notice";
import { LoadError } from "../../components/LoadError";
import { usePlan } from "../../lib/queries";
import { refreshPlan } from "../../lib/refreshPlan";
import { CardFaceFields } from "../../components/CardFaceFields";
import { NewCardButton } from "./NewCardButton";
import { StudyLayout } from "./StudyBar";
import { Working } from "../../components/Working";

const RATINGS = ["again", "hard", "good", "easy"] as const;
type RatingName = (typeof RATINGS)[number];

/** The last change the student can take back from the review: a rating, a suspend, or deleting a card Pyxis wrote. */
type Undoable =
  | { kind: "rate"; cardId: string; reviewId: string; rating: RatingName; intervalDays: number }
  | { kind: "suspend" | "delete"; cardId: string };

/** Keys for the card's menu, listed in the shortcuts dialog. Space, 1 to 4 and U work on the card itself. */
const MENU_KEYS = { edit: "e", suspend: "s", delete: "d" } as const;

/** A card's text without its Markdown emphasis, for a screen reader's label. */
const plainText = (markdown: string) => markdown.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

export function CardsPage() {
  const { t } = useTranslation();
  const { planId, topicId } = useParams();
  // Without a plan these are Oggi's due cards from every plan, closest exam first.
  const everywhere = !planId;
  // Without a topic this is the Review session: its stored cards, then its questions.
  const reviewing = !topicId && !everywhere;
  // Opened from a finished step on the path: looking again starts no card generation and records no step, unless the
  // student rates a card.
  const [searchParams] = useSearchParams();
  const looking = Boolean(topicId) && searchParams.get("review") === "1";
  const reviewQueue = useReviewSession(planId, reviewing);
  const navigate = useNavigate();
  const client = useQueryClient();
  const ratingLock = useRef(false);
  const [ratingPending, setRatingPending] = useState(false);
  const [ratingError, setRatingError] = useState(false);
  // Saving, suspending or deleting a card that fails says so instead of doing nothing.
  const [actionFailed, setActionFailed] = useState(false);
  const act = (request: Promise<unknown>, then: () => void) => {
    setActionFailed(false);
    request.then(then, () => setActionFailed(true));
  };
  const [showBack, setShowBack] = useState(false);
  // The face the card shows. It follows showBack half-way through the turn, when the card is edge-on; showBack changes
  // at once, so Space and then a rating key right after still rate.
  const [face, setFace] = useState(false);
  const [phase, setPhase] = useState<"out" | "in" | null>(null);
  const turnTimers = useRef<number[]>([]);
  const stopTurn = () => {
    for (const timer of turnTimers.current) window.clearTimeout(timer);
    turnTimers.current = [];
  };
  useEffect(() => stopTurn, []);
  /** Turns the card to its other face: it turns away until edge-on, shows the other face, and turns back in. */
  function turn() {
    // The control that turned the card goes away with its face, so the focus moves to the new face: the question and
    // answer, which a screen reader then reads, or Gira again. Focus elsewhere on the page stays where it is.
    const focus = document.activeElement;
    turnFocus.current = !focus || focus === document.body || Boolean(stage.current?.contains(focus));
    const next = !showBackRef.current;
    showBackRef.current = next;
    setShowBack(next);
    stopTurn();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setFace(next);
      setPhase(null);
      return;
    }
    setPhase("out");
    turnTimers.current.push(
      window.setTimeout(() => {
        setFace(next);
        setPhase("in");
        turnTimers.current.push(window.setTimeout(() => setPhase(null), 200));
      }, 160),
    );
  }
  const showBackRef = useRef(false);
  const stage = useRef<HTMLDivElement>(null);
  const answer = useRef<HTMLDivElement>(null);
  const flipButton = useRef<HTMLButtonElement>(null);
  const turnFocus = useRef(false);
  useEffect(() => {
    if (!turnFocus.current) return;
    turnFocus.current = false;
    (face ? answer.current : flipButton.current)?.focus();
  }, [face]);
  const [lastAction, setLastAction] = useState<Undoable | null>(null);
  // A card brought back by Undo shows next, wherever the deck would sort it.
  const [pinned, setPinned] = useState<string | null>(null);
  const [modal, modalContext] = Modal.useModal();
  const [seen, setSeen] = useState<Array<(typeof RATINGS)[number]>>([]);
  // Cards rated into a short learning step come back in this session instead of ending it.
  const [learning, setLearning] = useState<LearningCards>({});
  const [clock, setClock] = useState(Date.now());
  const [editing, setEditing] = useState(false);
  const [draftFront, setDraftFront] = useState("");
  const [draftBack, setDraftBack] = useState("");
  // The bar's New flashcard form; while it is open the card's keys are the form's.
  const [adding, setAdding] = useState(false);
  const cards = useQuery({
    queryKey: ["cards", planId, topicId],
    enabled: Boolean(planId) && !reviewing,
    queryFn: () =>
      invoke("study.cards", { planId: planId ?? "", topicId }),
  });
  const dueEverywhere = useQuery({
    queryKey: ["cards-everywhere"],
    enabled: everywhere,
    queryFn: () => invoke("study.dueEverywhere", {}),
  });
  const deck = everywhere ? dueEverywhere : cards;
  const parked = useQuery({
    queryKey: ["card-suspended", planId, topicId],
    enabled: Boolean(planId && topicId),
    queryFn: () =>
      invoke("study.suspended", {
        planId: planId ?? "",
        topicId: topicId ?? "",
      }),
  });
  const queue = useQuery({
    queryKey: ["card-queue", planId, topicId],
    enabled: Boolean(planId && topicId),
    queryFn: () =>
      invoke("study.queue", { planId: planId ?? "", topicId: topicId ?? "" }),
  });
  // Cards are built by a durable job; opening the page only starts it once per topic and watches it.
  const build = useQuery({
    queryKey: ["cards-build", planId, topicId],
    enabled: Boolean(planId && topicId),
    queryFn: () =>
      invoke("study.cardsBuild", {
        planId: planId ?? "",
        topicId: topicId ?? "",
      }),
    refetchInterval: (query) =>
      ["queued", "running"].includes(query.state.data?.state ?? "")
        ? 1500
        : false,
  });
  const buildState = build.data?.state;
  const building = buildState === "queued" || buildState === "running";
  const buildStopped =
    buildState === "failed" ||
    buildState === "cancelled" ||
    buildState === "interrupted";
  const [startFailed, setStartFailed] = useState(false);
  const requested = useRef("");
  async function generate() {
    if (!planId || !topicId) return;
    setStartFailed(false);
    try {
      await invoke("study.cardsGenerate", { planId, topicId });
    } catch {
      setStartFailed(true);
    }
    await Promise.all([build.refetch(), refresh()]);
  }
  useEffect(() => {
    const key = `${planId}:${topicId}`;
    if (looking || !build.isSuccess || build.data !== null || requested.current === key)
      return;
    requested.current = key;
    void generate();
  }, [looking, build.isSuccess, build.data, planId, topicId]);
  useEffect(() => {
    if (buildState === "succeeded") void refresh();
  }, [buildState]);
  // The build stores its cards a batch at a time and moves its progress with each one: show them as they arrive.
  const buildProgress = build.data?.progress ?? 0;
  useEffect(() => {
    if (building && buildProgress > 0) void refresh();
  }, [buildProgress]);
  const deckCards = everywhere
    ? dueEverywhere.data
    : reviewing
      ? reviewQueue.data?.cards
      : cards.data;
  const card =
    deckCards?.find((item) => item.id === pinned) ?? deckCards?.[0];
  // Oggi's cards come from several plans; the card on screen says which one it belongs to.
  const shownCard = everywhere ? dueEverywhere.data?.find((item) => item.id === card?.id) : undefined;
  const cardPlanId = everywhere ? shownCard?.planId : planId;
  useActiveTime(cardPlanId, topicId ?? (everywhere ? (card?.topicId ?? null) : null));
  // The plan and topic of each card rated here, so each plan's path gets its own cards step.
  const [ratedIn, setRatedIn] = useState<
    Array<{ planId: string; topicId: string; rating: (typeof RATINGS)[number] }>
  >([]);
  const plan = usePlan(cardPlanId);
  const topicTitle = topicId ? plan.data?.topics.find((topic) => topic.id === topicId)?.title : undefined;
  // Until the deck arrives (and the topic's build is known) "No cards are due." would be a guess.
  const shown = everywhere ? dueEverywhere : reviewing ? reviewQueue : cards;
  const deckLoading = shown.isLoading || (!reviewing && build.isLoading);
  // Said aloud when a rating brings up the next card; the old card's buttons are gone and focus falls to the page.
  // Until the rating's refresh has replaced the deck, the card shown is still the one just rated.
  const nextCardText =
    seen.length > 0 && !ratingPending && !ratingError && card
      ? plainText(isCloze(card.front) ? clozeQuestion(card.front) : card.front)
      : "";
  const [recorded, setRecorded] = useState(false);
  const [finishFailed, setFinishFailed] = useState(false);
  /** Records this topic's card session on the path: when its last due card is rated, or when the student closes it. */
  async function finishSession(): Promise<boolean> {
    if (everywhere) return finishEverywhere();
    if (!planId || !topicId) return false;
    if (recorded) return true;
    setFinishFailed(false);
    try {
      await invoke("plans.complete", {
        planId,
        activity: "cards",
        topicId,
        ...(seen.length
          ? {
              result: {
                correct: seen.filter((rating) => rating === "good" || rating === "easy").length,
                total: seen.length,
              },
            }
          : {}),
      });
      setRecorded(true);
      await refreshPlan(client, planId);
      return true;
    } catch {
      setFinishFailed(true);
      return false;
    }
  }
  /** Oggi's session records a cards step on each topic it rated, in each plan. */
  async function finishEverywhere(): Promise<boolean> {
    if (recorded || ratedIn.length === 0) return true;
    setFinishFailed(false);
    const groups = new Map<string, typeof ratedIn>();
    for (const entry of ratedIn) {
      const key = `${entry.planId}\n${entry.topicId}`;
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    try {
      for (const entries of groups.values())
        await invoke("plans.complete", {
          planId: entries[0]!.planId,
          activity: "cards",
          topicId: entries[0]!.topicId,
          result: {
            correct: entries.filter((entry) => entry.rating === "good" || entry.rating === "easy")
              .length,
            total: entries.length,
          },
        });
      setRecorded(true);
      await refreshPlan(client, ...ratedIn.map((entry) => entry.planId));
      return true;
    } catch {
      setFinishFailed(true);
      return false;
    }
  }
  const learningDue = reviewing ? null : nextLearningDue(learning);
  const waiting = !card && deck.isSuccess && learningDue != null;
  useEffect(() => {
    if (!waiting || learningDue == null) return;
    const tick = window.setInterval(() => setClock(Date.now()), 15_000);
    const due = window.setTimeout(
      () => {
        void deck.refetch().then(() => {
          // A card that is still due shows up now; one deleted or suspended meanwhile stops the wait.
          const now = Date.now();
          setLearning((current) =>
            Object.fromEntries(Object.entries(current).filter(([, at]) => at > now)),
          );
        });
      },
      Math.max(0, learningDue - Date.now()) + 500,
    );
    return () => {
      clearInterval(tick);
      clearTimeout(due);
    };
  }, [waiting, learningDue]);
  const sessionOver =
    !reviewing && seen.length > 0 && deck.isSuccess && !card && learningDue == null;
  useEffect(() => {
    if (sessionOver) void finishSession();
  }, [sessionOver]);
  // Editing needs a topic; a review card brings its own.
  const cardTopicId = topicId ?? card?.topicId ?? undefined;
  useEffect(() => {
    setEditing(false);
    stopTurn();
    showBackRef.current = false;
    setShowBack(false);
    setFace(false);
    setPhase(null);
  }, [card?.id]);
  const counts = { again: 0, hard: 0, good: 0, easy: 0 };
  for (const rating of seen) counts[rating] += 1;

  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["cards", planId, topicId] }),
      client.invalidateQueries({ queryKey: ["cards-everywhere"] }),
      client.invalidateQueries({ queryKey: ["review-session", planId] }),
      client.invalidateQueries({ queryKey: ["card-queue", planId, topicId] }),
      client.invalidateQueries({
        queryKey: ["card-suspended", planId, topicId],
      }),
    ]);
  }

  async function rate(rating: (typeof RATINGS)[number]) {
    if (!card || ratingLock.current) return;
    ratingLock.current = true;
    setRatingPending(true);
    setRatingError(false);
    try {
      const state = await invoke("study.rate", { cardId: card.id, rating });
      setLastAction({
        kind: "rate",
        cardId: card.id,
        reviewId: state.reviewId,
        rating,
        intervalDays: state.intervalDays,
      });
      setPinned(null);
      stopTurn();
      showBackRef.current = false;
      setShowBack(false);
      setFace(false);
      setPhase(null);
      setSeen((current) => [...current, rating]);
      if (everywhere && cardPlanId && card.topicId)
        setRatedIn((current) => [
          ...current,
          { planId: cardPlanId, topicId: card.topicId!, rating },
        ]);
      const now = Date.now();
      setClock(now);
      setLearning((current) => trackLearning(current, card.id, state.dueAt, now));
      await refresh();
    } catch {
      setRatingError(true);
    } finally {
      ratingLock.current = false;
      setRatingPending(false);
    }
  }

  /** Takes back the last rating, suspend or delete, and shows that card again. */
  async function undo() {
    if (!lastAction || ratingLock.current) return;
    ratingLock.current = true;
    setRatingPending(true);
    setActionFailed(false);
    const action = lastAction;
    try {
      if (action.kind === "rate") {
        await invoke("study.undoRate", { reviewId: action.reviewId });
        setSeen((current) => current.slice(0, -1));
        setRatedIn((current) => current.slice(0, -1));
        setLearning((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([id]) => id !== action.cardId),
          ),
        );
      } else if (action.kind === "suspend")
        await invoke("study.suspend", { cardId: action.cardId, suspended: false });
      else await invoke("study.restore", { cardId: action.cardId });
      setLastAction(null);
      setPinned(action.cardId);
      await refresh();
    } catch {
      setActionFailed(true);
    } finally {
      ratingLock.current = false;
      setRatingPending(false);
    }
  }

  function startEdit() {
    if (!card || !cardTopicId) return;
    setDraftFront(card.front);
    setDraftBack(card.back);
    setEditing(true);
  }

  function suspend() {
    if (!card) return;
    const cardId = card.id;
    act(invoke("study.suspend", { cardId, suspended: true }), () => {
      setLastAction({ kind: "suspend", cardId });
      setPinned(null);
      stopTurn();
      showBackRef.current = false;
      setShowBack(false);
      setFace(false);
      setPhase(null);
      void refresh();
    });
  }

  /** A card Pyxis wrote goes to Removed and Undo brings it back; a hand-made card is gone for good, so it asks first. */
  function remove() {
    if (!card) return;
    const cardId = card.id;
    const run = () =>
      act(invoke("study.remove", { cardId }), () => {
        setLastAction(card.handMade ? null : { kind: "delete", cardId });
        setPinned(null);
        stopTurn();
        showBackRef.current = false;
        setShowBack(false);
        setFace(false);
        setPhase(null);
        void refresh();
      });
    if (!card.handMade) return run();
    void modal.confirm({
      title: t("cardBrowser.deleteTitle"),
      content: t("cardBrowser.deleteHandMade"),
      okText: t("cards.deleteConfirm"),
      okButtonProps: { danger: true },
      cancelText: t("cardBrowser.cancel"),
      onOk: run,
    });
  }

  const [askFailed, setAskFailed] = useState(false);
  /** Opens a tutor chat about this card: its front, its back and the passage it came from. */
  async function askTutor() {
    if (!card) return;
    setAskFailed(false);
    try {
      const passage = card.passageId
        ? (await invoke("sources.passage", { passageId: card.passageId })).find(
            (item) => item.id === card.passageId,
          )
        : undefined;
      const front = isCloze(card.front) ? clozeAnswer(card.front) : card.front;
      const body = [
        `${t("cards.front")}: ${front}`,
        `${t("cards.back")}: ${card.back}`,
        passage
          ? `${t("cards.askSource", { section: passage.sectionPath ?? "" }).trim()}\n${passage.text}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      const seeded = await invoke("chats.seed", {
        kind: "answer",
        title: front.slice(0, 80),
        body,
        sourceIds: card.sourceId ? [card.sourceId] : undefined,
        planId: cardPlanId,
        subject: plan.data?.subject ?? undefined,
      });
      // Leaving for the tutor ends the visit like the X does, so the ratings so far reach the path.
      if (!reviewing && seen.length > 0 && !recorded && !(await finishSession())) return;
      navigate(`/ask/${seeded.chatId}`);
    } catch {
      setAskFailed(true);
    }
  }

  /** Every way out: a session with ratings is recorded on the path first, and a failure keeps the student here. */
  function leaveTo(path: string) {
    if (reviewing || seen.length === 0 || recorded) return navigate(path);
    void finishSession().then((ok) => ok && navigate(path));
  }
  function close() {
    // Oggi's session has no plan to go back to; it ends on the exams list.
    leaveTo(everywhere ? "/exams" : `/plans/${planId ?? ""}`);
  }

  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (
        editing ||
        adding ||
        ratingLock.current ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.repeat
      )
        return;
      const target = event.target as HTMLElement;
      if (
        target.closest(
          "input, textarea, select, button, [contenteditable=true], [role=dialog]",
        )
      )
        return;
      const letter = event.key.toLowerCase();
      if (letter === "u" && lastAction) {
        event.preventDefault();
        void undo();
        return;
      }
      if (!card) return;
      if (event.code === "Space") {
        event.preventDefault();
        turn();
      } else if (showBack && /^[1-4]$/.test(event.key)) {
        event.preventDefault();
        void rate(RATINGS[Number(event.key) - 1]!);
      } else if (letter === MENU_KEYS.edit && cardTopicId) {
        event.preventDefault();
        startEdit();
      } else if (letter === MENU_KEYS.suspend) {
        event.preventDefault();
        suspend();
      } else if (letter === MENU_KEYS.delete) {
        event.preventDefault();
        remove();
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [card, editing, adding, showBack, lastAction, cardTopicId]);

  // Oggi has no per-topic count: what is rated plus what is still queued, at most 20 queued at a time.
  const sessionTotal = reviewing
    ? (reviewQueue.data?.progress.total ?? 0)
    : seen.length + (everywhere ? (dueEverywhere.data?.length ?? 0) : (queue.data?.due ?? 0));
  const sessionDone = reviewing ? (reviewQueue.data?.progress.done ?? 0) : seen.length;
  // The header counts the card on screen: the first card reads "1 of 20".
  const sessionAt = Math.min(sessionTotal, sessionDone + (card ? 1 : 0));
  // New cards past today's limit wait for another day; the deck counts say how many of them this session holds.
  const freshToday = queue.data ? Math.min(queue.data.fresh, queue.data.newToday.left) : 0;
  // Export carries active and suspended cards; with neither there is nothing to export.
  const noCards =
    !queue.data ||
    (queue.data.fresh + queue.data.learning + queue.data.mastered === 0 && !parked.data?.length);
  // Today's new cards are used up and the topic still has new ones: say why the deck stops.
  const capped =
    !reviewing &&
    queue.data != null &&
    queue.data.newToday.left === 0 &&
    queue.data.fresh > 0;
  const undoText = !lastAction
    ? ""
    : lastAction.kind === "rate"
      ? `${t("cards.rated", { rating: t(`cards.${lastAction.rating}`) })} ${
          lastAction.intervalDays === 0
            ? t("cards.nextLearning")
            : t("cards.next", { count: lastAction.intervalDays })
        }.`
      : t(lastAction.kind === "suspend" ? "cards.suspended" : "cards.deleted");

  // Stops the cards being written; those already written stay.
  const cancelBuild = build.data ? (
    <Button
      type="text"
      size="small"
      onClick={() =>
        void invoke("jobs.cancel", { jobId: build.data?.jobId ?? "" }).then(() => build.refetch())
      }
    >
      {t("jobs.cancel")}
    </Button>
  ) : null;
  return (
    <StudyLayout
      back={
        everywhere
          ? { text: t("nav.exams"), onClick: close }
          : { text: plan.data?.title ?? t("lesson.back"), label: plan.data ? t("lesson.back") : undefined, onClick: close }
      }
      title={
        everywhere
          ? t("oggi.cardsTitle")
          : reviewing
            ? t("cards.reviewTitle")
            : [t("cards.title"), topicTitle].filter(Boolean).join(" \u00b7 ")
      }
      subtitle={
        sessionTotal > 0
          ? [shownCard?.planTitle, t("cards.sessionProgress", { done: sessionAt, total: sessionTotal })]
              .filter(Boolean)
              .join(" \u00b7 ")
          : shownCard?.planTitle
      }
      actions={
        <>
          {reviewing || everywhere ? null : (
            <NewCardButton
              open={adding}
              onOpenChange={setAdding}
              onAdd={async (front, back) => {
                await invoke("study.save", { planId: planId ?? "", topicId: topicId ?? "", front, back });
                void refresh();
              }}
            />
          )}
          <Button
            type="text"
            className="px-studybar-action"
            icon={<Undo2 size={16} strokeWidth={1.75} aria-hidden />}
            disabled={!lastAction || adding || ratingPending}
            aria-keyshortcuts="U"
            onClick={() => void undo()}
          >
            {t("cards.undoLast")}
          </Button>
          <Button
            type="text"
            className="px-studybar-action"
            icon={<Pencil size={16} strokeWidth={1.75} aria-hidden />}
            disabled={!card || !cardTopicId || editing || adding || ratingPending}
            aria-keyshortcuts={MENU_KEYS.edit.toUpperCase()}
            onClick={startEdit}
          >
            {t("cards.edit")}
          </Button>
        </>
      }
    >
      {modalContext}
      <section className="px-cards">
        {looking && !recorded ? <Notice tone="info">{t("cards.reviewing")}</Notice> : null}
        {ratingError ? (
          <Notice tone="danger">{t("cards.rateFailed")}</Notice>
        ) : null}
        {actionFailed ? (
          <Notice tone="danger">{t("cards.actionFailed")}</Notice>
        ) : null}
        {askFailed ? (
          <Notice tone="danger">{t("cards.askFailed")}</Notice>
        ) : null}
        {building && card ? (
          <Working line={t("cards.building")} action={cancelBuild} />
        ) : building ? (
          // The card below already shows the mark at work; this line only says what happens and how to stop it.
          <Notice
            tone="info"
            action={
              build.data
                ? {
                    label: t("jobs.cancel"),
                    onClick: () =>
                      void invoke("jobs.cancel", { jobId: build.data?.jobId ?? "" }).then(() => build.refetch()),
                  }
                : undefined
            }
          >
            {t("cards.building")}
          </Notice>
        ) : startFailed || buildStopped ? (
          <Notice
            tone={buildState === "cancelled" ? "info" : "danger"}
            action={{ label: t("cards.generateAgain"), onClick: () => void generate() }}
          >
            {t(buildState === "cancelled" ? "cards.buildCancelled" : "cards.buildFailed")}
          </Notice>
        ) : null}
        {reviewing && reviewQueue.data ? (
          <ReviewProgress progress={reviewQueue.data.progress} />
        ) : null}
        {/* One row: the deck counts, then what you can do with the deck. */}
        <div className="px-cards-toolbar">
          {queue.data ? (
            <p className="small">
              {freshToday < queue.data.fresh
                ? t("cards.freshToday", { count: queue.data.fresh, today: freshToday })
                : t("cards.fresh", { count: queue.data.fresh })}
              {" · "}
              {t("cards.learning", { count: queue.data.learning })}
              {" · "}
              {t("cards.mastered", { count: queue.data.mastered })}
            </p>
          ) : null}
          {reviewing || everywhere ? null : (
            <div className="px-cards-toolbar-actions">
              <ExportButton
                planId={planId ?? ""}
                topicId={topicId}
                kind="cards"
                disabled={noCards}
              />
            </div>
          )}
        </div>
        {finishFailed ? (
          <Notice tone="danger">{t("planOverview.failed")}</Notice>
        ) : null}
        <div className="visually-hidden" role="status" aria-live="polite">
          {nextCardText ? t("cards.nextCard", { front: nextCardText }) : ""}
        </div>
        {!card ? (
          building ? (
            // While the first cards are written, a card waits where they will appear, with the mark at work.
            <div className="px-cards-stage">
              <div className="px-card px-card-waiting" role="status">
                <Logo size={40} working decorative />
                <p>{t("cards.writingFirst")}</p>
              </div>
            </div>
          ) : deckLoading ? null : shown.isError ? (
            <LoadError
              onRetry={() => void shown.refetch()}
              details={errorDetails(shown.error)}
            >
              {t("cards.loadFailed")}
            </LoadError>
          ) : waiting && learningDue != null ? (
            <p className="body" role="status">
              {t("cards.learningWait", {
                count: Math.max(1, Math.ceil((learningDue - clock) / 60_000)),
              })}
            </p>
          ) : capped ? (
            <p className="body">
              {t("cards.dailyLimit", { count: queue.data?.newToday.limit ?? 0 })}{" "}
              <Link
                to="/settings/flashcards"
                onClick={(event) => {
                  event.preventDefault();
                  leaveTo("/settings/flashcards");
                }}
              >
                {t("cards.changeLimit")}
              </Link>
            </p>
          ) : (
            <p className="body">{t("cards.empty")}</p>
          )
        ) : (
          <div className="px-cards-stage" ref={stage}>
            {sessionTotal > 0 && !reviewing ? (
              <div
                className="px-cards-progress"
                role="progressbar"
                aria-label={t("cards.progressLabel")}
                aria-valuemin={0}
                aria-valuemax={sessionTotal}
                aria-valuenow={sessionDone}
              >
                <i style={{ width: `${(100 * sessionDone) / sessionTotal}%` }} />
              </div>
            ) : null}
            {/* The card turns over when it shows its other face: data-turn is "out" until it is edge-on, then "in". */}
            <article
              className="px-card"
              aria-label={t("cards.card")}
              data-face={face ? "back" : "front"}
              data-turn={phase ?? undefined}
            >
              <div className="px-card-top">
                <Dropdown
                  trigger={["click"]}
                  disabled={ratingPending || editing}
                  menu={{
                    items: [
                      {
                        key: "edit",
                        label: t("cards.edit"),
                        disabled: !cardTopicId,
                        extra: <kbd>{MENU_KEYS.edit.toUpperCase()}</kbd>,
                      },
                      {
                        key: "suspend",
                        label: t("cards.suspend"),
                        extra: <kbd>{MENU_KEYS.suspend.toUpperCase()}</kbd>,
                      },
                      {
                        key: "delete",
                        label: t("cards.delete"),
                        danger: true,
                        extra: <kbd>{MENU_KEYS.delete.toUpperCase()}</kbd>,
                      },
                    ],
                    onClick: ({ key }) =>
                      key === "edit"
                        ? startEdit()
                        : key === "suspend"
                          ? suspend()
                          : remove(),
                  }}
                >
                  <Button
                    type="text"
                    shape="circle"
                    aria-label={t("cards.more")}
                    icon={<Ellipsis size={18} strokeWidth={1.75} aria-hidden />}
                  />
                </Dropdown>
              </div>
              {editing ? (
                <div className="px-card-edit">
                  <CardFaceFields
                    idPrefix="card"
                    front={draftFront}
                    back={draftBack}
                    onFront={setDraftFront}
                    onBack={setDraftBack}
                  />
                  <div className="px-card-edit-actions">
                    <Button
                      type="primary"
                      shape="round"
                      onClick={() => {
                        if (!cardPlanId || !cardTopicId) return;
                        act(
                          invoke("study.save", {
                            planId: cardPlanId,
                            topicId: cardTopicId,
                            cardId: card.id,
                            front: draftFront,
                            back: draftBack,
                          }),
                          () => {
                            setEditing(false);
                            refresh();
                          },
                        );
                      }}
                      disabled={!draftFront.trim() || !draftBack.trim()}
                    >
                      {t("cards.save")}
                    </Button>
                    <Button shape="round" onClick={() => setEditing(false)}>
                      {t("cardBrowser.cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="px-card-face">
                  {face ? (
                    <>
                      {/* The focus lands here after a turn: the question with a cloze card's answer filled in, then the
                          back, so a screen reader reads both. */}
                      <div className="px-card-reveal" ref={answer} tabIndex={-1}>
                        <div className="px-card-asked">
                          <MarkdownView>{isCloze(card.front) ? clozeAnswer(card.front) : card.front}</MarkdownView>
                        </div>
                        <hr />
                        <div className="px-card-back">
                          <MarkdownView>{card.back}</MarkdownView>
                        </div>
                      </div>
                      <div className="px-card-links">
                        {card.sectionPath && card.passageId && card.sourceId ? (
                          <CitationChip
                            onClick={() =>
                              openSourceViewer({
                                passageId: card.passageId ?? undefined,
                                sourceId: card.sourceId ?? undefined,
                              })
                            }
                          >
                            {card.sectionPath}
                          </CitationChip>
                        ) : null}
                        <Button
                          type="text"
                          shape="round"
                          size="small"
                          icon={<MessageCircleQuestion size={16} strokeWidth={1.75} aria-hidden />}
                          onClick={() => void askTutor()}
                        >
                          {t("cards.askTutor")}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      {card.sectionPath ? <p className="px-card-kicker">{card.sectionPath}</p> : null}
                      <div className="px-card-front">
                        <MarkdownView>{isCloze(card.front) ? clozeQuestion(card.front) : card.front}</MarkdownView>
                      </div>
                    </>
                  )}
                </div>
              )}
            </article>
            {editing ? null : showBack ? (
              <>
                <div className="px-cards-actions" role="group" aria-label={t("cards.rateLabel")}>
                  {RATINGS.map((rating, index) => (
                    <Button
                      key={rating}
                      disabled={ratingPending}
                      aria-keyshortcuts={String(index + 1)}
                      onClick={() => void rate(rating)}
                    >
                      {t(`cards.${rating}`)}
                      <kbd aria-hidden>{index + 1}</kbd>
                    </Button>
                  ))}
                </div>
                <p className="px-cards-hint">{t("cards.rateHint")}</p>
              </>
            ) : (
              <>
                <div className="px-cards-flip">
                  <Button ref={flipButton} type="primary" size="large" aria-keyshortcuts="Space" onClick={turn}>
                    {t("cards.flip")}
                    <kbd aria-hidden>{t("cards.spaceKey")}</kbd>
                  </Button>
                </div>
                <p className="px-cards-hint">{t("cards.flipHint")}</p>
              </>
            )}
          </div>
        )}
        {/* What the last change did; the bar's Undo last takes it back. */}
        {lastAction ? (
          <div className="px-cards-undo">
            <p className="small" role="status">
              {undoText}
            </p>
          </div>
        ) : null}
        {(parked.data ?? []).map((item) => (
          <div key={item.id} className="px-cards-parked">
            <MarkdownView variant="body">
              {isCloze(item.front) ? clozeAnswer(item.front) : item.front}
            </MarkdownView>
            <Button
              shape="round"
              aria-label={t("cards.resumeCard", {
                front: plainText(
                  isCloze(item.front) ? clozeAnswer(item.front) : item.front,
                ),
              })}
              onClick={() => {
                act(
                  invoke("study.suspend", {
                    cardId: item.id,
                    suspended: false,
                  }),
                  () => refresh(),
                );
              }}
            >
              {t("cards.resume")}
            </Button>
          </div>
        ))}
        {reviewing && reviewQueue.data?.next === "questions" && !card ? (
          <Button
            type="primary"
            shape="round"
            onClick={() =>
              navigate(
                `/plans/${planId ?? ""}/review/questions?attempt=${encodeURIComponent(reviewQueue.data?.attemptId ?? "")}`,
              )
            }
          >
            {t("cards.reviewQuestions")}
          </Button>
        ) : null}
        {reviewing && reviewQueue.data?.next === "waiting" && !card ? (
          <Notice
            tone="info"
            action={{
              label: t("cards.reviewWaitingOpen"),
              onClick: () => navigate(`/plans/${planId ?? ""}/review`),
            }}
          >
            {t("cards.reviewWaiting", { count: reviewQueue.data.progress.questionsPending })}
          </Notice>
        ) : null}
        {seen.length > 0 && !card ? (
          <p className="body" role="status">
            {t("cards.summary", {
              seen: seen.length,
              again: counts.again,
              hard: counts.hard,
              good: counts.good,
              easy: counts.easy,
            })}
          </p>
        ) : null}
      </section>
    </StudyLayout>
  );
}
