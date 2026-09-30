import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { useState } from "react";
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
  const cards = useQuery({
    queryKey: ["cards", planId, topicId],
    enabled: Boolean(planId && topicId),
    queryFn: () => invoke("study.cards", { planId: planId ?? "", topicId: topicId ?? "" }),
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

  return (
    <FocusLayout
      title={t("cards.title")}
      secondary={
        <Button type="text" shape="round" onClick={() => navigate(`/plans/${planId ?? ""}`)}>
          {t("nav.back")}
        </Button>
      }
    >
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
          <MarkdownView>{card.front}</MarkdownView>
          {showBack ? <MarkdownView>{card.back}</MarkdownView> : null}
          {showBack && card.sectionPath ? <CitationChip>{card.sectionPath}</CitationChip> : null}
          {intervalDays != null ? (
            <p className="small">{t("cards.next", { days: intervalDays })}</p>
          ) : null}
          {!showBack ? (
            <Button type="primary" shape="round" onClick={() => setShowBack(true)}>
              {t("cards.flip")}
            </Button>
          ) : (
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
                      void client.invalidateQueries({ queryKey: ["cards", planId, topicId] });
                    });
                  }}
                >
                  {t(`cards.${rating}`)}
                </Button>
              ))}
            </div>
          )}
        </article>
      )}
    </FocusLayout>
  );
}
