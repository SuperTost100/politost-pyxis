import { openSourceViewer } from "../../components/SourceViewer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "antd";
import "./CardsPage.css";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { CitationChip } from "../../components/CitationChip";
import { MarkdownView } from "../../components/MarkdownView";
import { ExportButton } from "../share/ExportButton";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";

import { review } from "../../../../core/study/schedule";
import { clozeAnswer, clozeQuestion, isCloze } from "../../../../core/study/cloze";
import { Notice } from "../../components/Notice";

const RATINGS = ["again", "hard", "good", "easy"] as const;

export function CardsPage() {
  const { t } = useTranslation();
  const { planId, topicId } = useParams();
  useActiveTime(planId, topicId ?? null);
  const navigate = useNavigate();
  const client = useQueryClient();
  const ratingLock = useRef(false);
  const [ratingPending, setRatingPending] = useState(false);
  const [ratingError, setRatingError] = useState(false);
  const [showBack, setShowBack] = useState(false);
  const [intervalDays, setIntervalDays] = useState<number | null>(null);
  const [seen, setSeen] = useState<Array<(typeof RATINGS)[number]>>([]);
  const [editing, setEditing] = useState(false);
  const [draftFront, setDraftFront] = useState("");
  const [draftBack, setDraftBack] = useState("");
  const [addingFront, setAddingFront] = useState("");
  const [addingBack, setAddingBack] = useState("");
  const [armedDelete, setArmedDelete] = useState(false);
  const cards = useQuery({
    queryKey: ["cards", planId, topicId],
    enabled: Boolean(planId && topicId),
    queryFn: () =>
      invoke("study.cards", { planId: planId ?? "", topicId: topicId ?? "" }),
  });
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
    if (!build.isSuccess || build.data !== null || requested.current === key)
      return;
    requested.current = key;
    void generate();
  }, [build.isSuccess, build.data, planId, topicId]);
  useEffect(() => {
    if (buildState === "succeeded") void refresh();
  }, [buildState]);
  const plan = useQuery({
    queryKey: ["plan", planId],
    enabled: Boolean(planId),
    queryFn: () => invoke("plans.read", { planId: planId ?? "" }),
  });
  const node = (plan.data?.nodes ?? []).find(
    (item) =>
      item.kind === "cards" &&
      item.topicId === topicId &&
      item.state === "current",
  );
  const card = cards.data?.[0];
  useEffect(() => {
    setArmedDelete(false);
    setEditing(false);
    setShowBack(false);
  }, [card?.id]);
  const counts = { again: 0, hard: 0, good: 0, easy: 0 };
  for (const rating of seen) counts[rating] += 1;

  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["cards", planId, topicId] }),
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
      setIntervalDays(state.intervalDays);
      setShowBack(false);
      setSeen((current) => [...current, rating]);
      await refresh();
    } catch {
      setRatingError(true);
    } finally {
      ratingLock.current = false;
      setRatingPending(false);
    }
  }

  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (
        !card ||
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
      if (event.code === "Space") {
        event.preventDefault();
        setShowBack((current) => !current);
      } else if (showBack && /^[1-4]$/.test(event.key)) {
        event.preventDefault();
        void rate(RATINGS[Number(event.key) - 1]!);
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [card, editing, showBack]);

  return (
    <FocusLayout
      title={t("cards.title")}
      secondary={
        <Button
          type="text"
          shape="round"
          onClick={() => navigate(`/plans/${planId ?? ""}`)}
        >
          {t("nav.back")}
        </Button>
      }
    >
      <section className="px-cards">
        {ratingError ? (
          <Notice tone="danger">{t("cards.rateFailed")}</Notice>
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
        <ExportButton planId={planId ?? ""} topicId={topicId} kind="cards" />
        {queue.data ? (
          <p className="small">
            {t("cards.fresh", { count: queue.data.fresh })}
            {" · "}
            {t("cards.learning", { count: queue.data.learning })}
            {" · "}
            {t("cards.mastered", { count: queue.data.mastered })}
          </p>
        ) : null}
        {node ? (
          <Button
            shape="round"
            onClick={() => {
              if (!planId) return;
              void invoke("plans.complete", { planId, nodeId: node.id }).then(
                () => {
                  void client.invalidateQueries({ queryKey: ["plan", planId] });
                  navigate(`/plans/${planId}`);
                },
              );
            }}
          >
            {t("lesson.done")}
          </Button>
        ) : null}
        {!card ? (
          building ? null : (
            <p className="body">{t("cards.empty")}</p>
          )
        ) : (
          <article className="passage px-card">
            {editing ? (
              <>
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
                <Button
                  type="primary"
                  shape="round"
                  onClick={() => {
                    if (!planId || !topicId) return;
                    void invoke("study.save", {
                      planId,
                      topicId,
                      cardId: card.id,
                      front: draftFront,
                      back: draftBack,
                    }).then(() => {
                      setEditing(false);
                      refresh();
                    });
                  }}
                  disabled={!draftFront.trim() || !draftBack.trim()}
                >
                  {t("cards.save")}
                </Button>
              </>
            ) : (
              <MarkdownView>
                {isCloze(card.front)
                  ? (showBack ? clozeAnswer : clozeQuestion)(card.front)
                  : card.front}
              </MarkdownView>
            )}
            {showBack && !editing ? (
              <MarkdownView>{card.back}</MarkdownView>
            ) : null}
            {showBack &&
            !editing &&
            card.sectionPath &&
            card.passageId &&
            card.sourceId ? (
              <CitationChip
                onClick={() => {
                  const params = new URLSearchParams({
                    source: card.sourceId ?? "",
                    passage: card.passageId ?? "",
                  });
                  if (card.chapter != null)
                    params.set("chapter", String(card.chapter));
                  openSourceViewer({
                    passageId: params.get("passage") ?? undefined,
                    sourceId: params.get("source") ?? undefined,
                  });
                }}
              >
                {card.sectionPath}
              </CitationChip>
            ) : null}
            {intervalDays != null ? (
              <p className="small">
                {intervalDays === 0
                  ? t("cards.nextLearning")
                  : t("cards.next", { count: intervalDays })}
              </p>
            ) : null}
            {!showBack && !editing ? (
              <Button
                type="primary"
                shape="round"
                onClick={() => setShowBack(true)}
              >
                {t("cards.flip")} <kbd>Space</kbd>
              </Button>
            ) : null}
            {showBack && !editing ? (
              <>
                <div className="px-cards-actions">
                  {RATINGS.map((rating, index) => (
                    <Button
                      key={rating}
                      shape="round"
                      type={rating === "good" ? "primary" : "default"}
                      disabled={ratingPending}
                      onClick={() => void rate(rating)}
                    >
                      {t(`cards.${rating}`)} <kbd>{index + 1}</kbd>
                      <span className="px-card-interval">
                        {(() => {
                          const now = Date.now();
                          const minutes = Math.max(
                            1,
                            Math.round(
                              (review(card.state, rating, now).dueAt - now) /
                                60000,
                            ),
                          );
                          return minutes < 60
                            ? t("cards.intervalMinutes", { count: minutes })
                            : minutes < 1440
                              ? t("cards.intervalHours", {
                                  count: Math.round(minutes / 60),
                                })
                              : t("cards.intervalDays", {
                                  count: Math.round(minutes / 1440),
                                });
                        })()}
                      </span>
                    </Button>
                  ))}
                </div>
                <div className="px-cards-actions px-cards-manage">
                  <Button
                    disabled={ratingPending}
                    shape="round"
                    onClick={() => {
                      setDraftFront(card.front);
                      setDraftBack(card.back);
                      setEditing(true);
                    }}
                  >
                    {t("cards.edit")}
                  </Button>
                  <Button
                    disabled={ratingPending}
                    shape="round"
                    onClick={() => {
                      void invoke("study.suspend", {
                        cardId: card.id,
                        suspended: true,
                      }).then(() => {
                        setShowBack(false);
                        refresh();
                      });
                    }}
                  >
                    {t("cards.suspend")}
                  </Button>
                  <Button
                    disabled={ratingPending}
                    shape="round"
                    onClick={() => {
                      if (!armedDelete) {
                        setArmedDelete(true);
                        return;
                      }
                      void invoke("study.remove", { cardId: card.id }).then(
                        () => {
                          setArmedDelete(false);
                          setShowBack(false);
                          refresh();
                        },
                      );
                    }}
                  >
                    {armedDelete ? t("cards.deleteConfirm") : t("cards.delete")}
                  </Button>
                </div>
              </>
            ) : null}
          </article>
        )}
        {(parked.data ?? []).map((item) => (
          <p key={item.id} className="small">
            {item.front}{" "}
            <Button
              shape="round"
              onClick={() => {
                void invoke("study.suspend", {
                  cardId: item.id,
                  suspended: false,
                }).then(() => refresh());
              }}
            >
              {t("cards.resume")}
            </Button>
          </p>
        ))}
        {seen.length > 0 && !card ? (
          <p className="body">
            {t("cards.summary", {
              seen: seen.length,
              again: counts.again,
              hard: counts.hard,
              good: counts.good,
              easy: counts.easy,
            })}
          </p>
        ) : null}
        <section className="px-cards-add" aria-label={t("cards.add")}>
          <h2 className="body-strong">{t("cards.add")}</h2>
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
              void invoke("study.save", {
                planId,
                topicId,
                front: addingFront,
                back: addingBack,
              }).then(() => {
                setAddingFront("");
                setAddingBack("");
                refresh();
              });
            }}
            disabled={!addingFront.trim() || !addingBack.trim()}
          >
            {t("cards.save")}
          </Button>
        </section>
      </section>
    </FocusLayout>
  );
}
