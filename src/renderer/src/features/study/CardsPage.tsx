import { openSourceViewer } from "../../components/SourceViewer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dropdown, Input, Modal } from "antd";
import { Ellipsis, MessageCircleQuestion } from "lucide-react";
import "./CardsPage.css";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { CitationChip } from "../../components/CitationChip";
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
  const [addingFront, setAddingFront] = useState("");
  const [addingBack, setAddingBack] = useState("");
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
  const plan = useQuery({
    queryKey: ["plan", cardPlanId],
    enabled: Boolean(cardPlanId),
    queryFn: () => invoke("plans.read", { planId: cardPlanId ?? "" }),
  });
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
      await Promise.all(
        [["plan", planId], ["recommend", planId]].map((queryKey) =>
          client.invalidateQueries({ queryKey }),
        ),
      );
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
      await Promise.all(
        [["plans"], ["plan"], ["recommend"]].map((queryKey) =>
          client.invalidateQueries({ queryKey }),
        ),
      );
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
    setShowBack(false);
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
      setShowBack(false);
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
      setShowBack(false);
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
        setShowBack(false);
        void refresh();
      });
    if (!card.handMade) return run();
    void modal.confirm({
      title: t("cardBrowser.deleteTitle"),
      content: t("cardBrowser.deleteHandMade"),
      okText: t("cards.deleteConfirm"),
      // The filled danger button fails contrast in the dark theme, so the destructive choice is outlined.
      okType: "default",
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

  /** The only way out: a session with ratings is recorded on the path first. */
  function close() {
    // Oggi's session has no plan to go back to; it ends on the exams list.
    const home = everywhere ? "/exams" : `/plans/${planId ?? ""}`;
    if (reviewing || seen.length === 0 || recorded) return navigate(home);
    void finishSession().then((ok) => ok && navigate(home));
  }

  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (
        editing ||
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
        setShowBack((current) => !current);
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
  }, [card, editing, showBack, lastAction, cardTopicId]);

  // Oggi has no per-topic count: what is rated plus what is still queued, at most 20 queued at a time.
  const sessionTotal = reviewing
    ? (reviewQueue.data?.progress.total ?? 0)
    : seen.length + (everywhere ? (dueEverywhere.data?.length ?? 0) : (queue.data?.due ?? 0));
  const sessionDone = reviewing ? (reviewQueue.data?.progress.done ?? 0) : seen.length;
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

  return (
    <FocusLayout
      title={t(everywhere ? "oggi.cardsTitle" : reviewing ? "cards.reviewTitle" : "cards.title")}
      meta={
        sessionTotal > 0
          ? [shownCard?.planTitle, t("cards.sessionProgress", { done: sessionDone, total: sessionTotal })]
              .filter(Boolean)
              .join(" \u00b7 ")
          : shownCard?.planTitle
      }
      onClose={close}
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
        {building ? (
          <Notice
            tone="info"
            action={
              build.data
                ? {
                    label: t("jobs.cancel"),
                    onClick: () =>
                      void invoke("jobs.cancel", {
                        jobId: build.data?.jobId ?? "",
                      }).then(() => build.refetch()),
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
              {t("cards.fresh", { count: queue.data.fresh })}
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
          building || deckLoading ? null : shown.isError ? (
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
              {t("cards.dailyLimit", { count: queue.data?.newToday.limit ?? 0 })}
            </p>
          ) : (
            <p className="body">{t("cards.empty")}</p>
          )
        ) : (
          <article className="px-card" aria-label={t("cards.card")}>
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
                <label className="label" htmlFor="card-front">
                  {t("cards.front")}
                </label>
                <Input.TextArea
                  autoSize={{ minRows: 2, maxRows: 8 }}
                  id="card-front"
                  value={draftFront}
                  onChange={(event) => setDraftFront(event.target.value)}
                />
                <label className="label" htmlFor="card-back">
                  {t("cards.back")}
                </label>
                <Input.TextArea
                  autoSize={{ minRows: 2, maxRows: 8 }}
                  id="card-back"
                  value={draftBack}
                  onChange={(event) => setDraftBack(event.target.value)}
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
                <div className="px-card-front">
                  <MarkdownView>
                    {isCloze(card.front)
                      ? (showBack ? clozeAnswer : clozeQuestion)(card.front)
                      : card.front}
                  </MarkdownView>
                </div>
                {showBack ? (
                  <div className="px-card-back">
                    <MarkdownView>{card.back}</MarkdownView>
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
                        icon={
                          <MessageCircleQuestion
                            size={16}
                            strokeWidth={1.75}
                            aria-hidden
                          />
                        }
                        onClick={() => void askTutor()}
                      >
                        {t("cards.askTutor")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
            {editing ? null : (
              <div className="px-card-foot">
                {showBack ? (
                  <div className="px-cards-actions">
                    {RATINGS.map((rating, index) => (
                      <Button
                        key={rating}
                        shape="round"
                        type={rating === "good" ? "primary" : "default"}
                        disabled={ratingPending}
                        aria-keyshortcuts={String(index + 1)}
                        onClick={() => void rate(rating)}
                      >
                        {t(`cards.${rating}`)}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <Button
                    type="primary"
                    shape="round"
                    onClick={() => setShowBack(true)}
                  >
                    {t("cards.flip")} <kbd>{t("cards.spaceKey")}</kbd>
                  </Button>
                )}
              </div>
            )}
          </article>
        )}
        {lastAction ? (
          <div className="px-cards-undo">
            <p className="small" role="status">
              {undoText}
            </p>
            <Button
              type="text"
              shape="round"
              size="small"
              disabled={ratingPending}
              aria-keyshortcuts="U"
              onClick={() => void undo()}
            >
              {t("cards.undo")}
            </Button>
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
                `/plans/${planId ?? ""}/diagnostic?attempt=${encodeURIComponent(reviewQueue.data?.attemptId ?? "")}`,
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
        {reviewing || everywhere ? null : (
        <details className="px-cards-add">
          <summary className="body-strong">{t("cards.add")}</summary>
          <label className="small" htmlFor="new-front">
            {t("cards.front")}
          </label>
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 8 }}
            id="new-front"
            value={addingFront}
            onChange={(event) => setAddingFront(event.target.value)}
            placeholder={t("cards.front")}
          />
          <label className="small" htmlFor="new-back">
            {t("cards.back")}
          </label>
          <Input.TextArea
            id="new-back"
            autoSize={{ minRows: 2, maxRows: 8 }}
            value={addingBack}
            onChange={(event) => setAddingBack(event.target.value)}
            placeholder={t("cards.back")}
            aria-label={t("cards.back")}
          />
          <Button
            shape="round"
            onClick={() => {
              if (!planId || !topicId) return;
              act(
                invoke("study.save", {
                  planId,
                  topicId,
                  front: addingFront,
                  back: addingBack,
                }),
                () => {
                  setAddingFront("");
                  setAddingBack("");
                  refresh();
                },
              );
            }}
            disabled={!addingFront.trim() || !addingBack.trim()}
          >
            {t("cards.save")}
          </Button>
        </details>
        )}
      </section>
    </FocusLayout>
  );
}
