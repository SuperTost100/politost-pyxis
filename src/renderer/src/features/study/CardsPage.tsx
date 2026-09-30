import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { CitationChip } from "../../components/CitationChip";
import { MarkdownView } from "../../components/MarkdownView";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";

const RATINGS = ["again", "hard", "good", "easy"] as const;

export function CardsPage() {
  const { t } = useTranslation();
  const { planId, topicId } = useParams();
  useActiveTime(planId, topicId ?? null);
  const navigate = useNavigate();
  const client = useQueryClient();
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
    queryFn: () => invoke("study.cards", { planId: planId ?? "", topicId: topicId ?? "" }),
  });
  const parked = useQuery({
    queryKey: ["card-suspended", planId, topicId],
    enabled: Boolean(planId && topicId),
    queryFn: () => invoke("study.suspended", { planId: planId ?? "", topicId: topicId ?? "" }),
  });
  const queue = useQuery({
    queryKey: ["card-queue", planId, topicId],
    enabled: Boolean(planId && topicId),
    queryFn: () => invoke("study.queue", { planId: planId ?? "", topicId: topicId ?? "" }),
  });
  const plan = useQuery({
    queryKey: ["plan", planId],
    enabled: Boolean(planId),
    queryFn: () => invoke("plans.read", { planId: planId ?? "" }),
  });
  const node = (plan.data?.nodes ?? []).find(
    (item) => item.kind === "cards" && item.topicId === topicId && item.state === "current",
  );
  const card = cards.data?.[0];
  useEffect(() => {
    setArmedDelete(false);
    setEditing(false);
  }, [card?.id]);
  const counts = { again: 0, hard: 0, good: 0, easy: 0 };
  for (const rating of seen) counts[rating] += 1;

  function refresh() {
    void client.invalidateQueries({ queryKey: ["cards", planId, topicId] });
    void client.invalidateQueries({ queryKey: ["card-queue", planId, topicId] });
    void client.invalidateQueries({ queryKey: ["card-suspended", planId, topicId] });
  }

  return (
    <FocusLayout
      title={t("cards.title")}
      secondary={
        <Button type="text" shape="round" onClick={() => navigate(`/plans/${planId ?? ""}`)}>
          {t("nav.back")}
        </Button>
      }
    >
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
            void invoke("plans.complete", { planId, nodeId: node.id }).then(() => {
              void client.invalidateQueries({ queryKey: ["plan", planId] });
              navigate(`/plans/${planId}`);
            });
          }}
        >
          {t("lesson.done")}
        </Button>
      ) : null}
      {!card ? (
        <p className="body">{t("cards.empty")}</p>
      ) : (
        <article className="passage">
          {editing ? (
            <>
              <label className="label" htmlFor="card-front">
                {t("cards.front")}
              </label>
              <input id="card-front" value={draftFront} onChange={(event) => setDraftFront(event.target.value)} />
              <label className="label" htmlFor="card-back">
                {t("cards.back")}
              </label>
              <input id="card-back" value={draftBack} onChange={(event) => setDraftBack(event.target.value)} />
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
            <MarkdownView>{card.front}</MarkdownView>
          )}
          {showBack && !editing ? <MarkdownView>{card.back}</MarkdownView> : null}
          {showBack && !editing && card.sectionPath && card.passageId && card.sourceId ? (
            <CitationChip
              onClick={() => {
                const params = new URLSearchParams({
                  source: card.sourceId ?? "",
                  passage: card.passageId ?? "",
                });
                if (card.chapter != null) params.set("chapter", String(card.chapter));
                navigate(`/exams/library?${params.toString()}`);
              }}
            >
              {card.sectionPath}
            </CitationChip>
          ) : null}
          {intervalDays != null ? (
            <p className="small">{t("cards.next", { days: intervalDays })}</p>
          ) : null}
          {!showBack && !editing ? (
            <Button type="primary" shape="round" onClick={() => setShowBack(true)}>
              {t("cards.flip")}
            </Button>
          ) : null}
          {showBack && !editing ? (
            <div>
              {RATINGS.map((rating) => (
                <Button
                  key={rating}
                  shape="round"
                  type={rating === "good" ? "primary" : "default"}
                  onClick={() => {
                    void invoke("study.rate", { cardId: card.id, rating }).then((state) => {
                      setIntervalDays(state.intervalDays);
                      setShowBack(false);
                      setSeen((current) => [...current, rating]);
                      refresh();
                    });
                  }}
                >
                  {t(`cards.${rating}`)}
                </Button>
              ))}
              <Button
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
                shape="round"
                onClick={() => {
                  void invoke("study.suspend", { cardId: card.id, suspended: true }).then(() => {
                    setShowBack(false);
                    refresh();
                  });
                }}
              >
                {t("cards.suspend")}
              </Button>
              <Button
                shape="round"
                onClick={() => {
                  if (!armedDelete) {
                    setArmedDelete(true);
                    return;
                  }
                  void invoke("study.remove", { cardId: card.id }).then(() => {
                    setArmedDelete(false);
                    setShowBack(false);
                    refresh();
                  });
                }}
              >
                {armedDelete ? t("cards.deleteConfirm") : t("cards.delete")}
              </Button>
            </div>
          ) : null}
        </article>
      )}
      {(parked.data ?? []).map((item) => (
        <p key={item.id} className="small">
          {item.front}{" "}
          <Button
            shape="round"
            onClick={() => {
              void invoke("study.suspend", { cardId: item.id, suspended: false }).then(() => refresh());
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
      <label className="label" htmlFor="new-front">
        {t("cards.add")}
      </label>
      <input id="new-front" value={addingFront} onChange={(event) => setAddingFront(event.target.value)} placeholder={t("cards.front")} />
      <input value={addingBack} onChange={(event) => setAddingBack(event.target.value)} placeholder={t("cards.back")} aria-label={t("cards.back")} />
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
    </FocusLayout>
  );
}
