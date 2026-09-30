import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { MarkdownView } from "../../components/MarkdownView";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";

export function PracticePage() {
  const { t } = useTranslation();
  const { planId, topicId } = useParams();
  useActiveTime(planId, topicId ?? null);
  const navigate = useNavigate();
  const client = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const plan = useQuery({
    queryKey: ["plan", planId],
    enabled: Boolean(planId),
    queryFn: () => invoke("plans.read", { planId: planId ?? "" }),
  });
  const node = (plan.data?.nodes ?? []).find(
    (item) => item.kind === "practice" && item.topicId === topicId && item.state === "current",
  );
  const exercises = useQuery({
    queryKey: ["exercises", topicId],
    enabled: Boolean(topicId),
    queryFn: () => invoke("study.exercises", { topicId: topicId ?? "" }),
  });

  return (
    <FocusLayout
      title={t("practice.title")}
      secondary={
        <Button type="text" shape="round" onClick={() => navigate(`/plans/${planId ?? ""}`)}>
          {t("nav.back")}
        </Button>
      }
    >
      <Button
        shape="round"
        onClick={() => navigate(`/plans/${planId ?? ""}/quiz/${topicId ?? ""}`)}
      >
        {t("quiz.title")}
      </Button>
      {node ? (
        <Button
          type="primary"
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
      {(exercises.data ?? []).length === 0 ? (
        <p className="body">{t("practice.empty")}</p>
      ) : (
        <ol className="choice-list">
          {(exercises.data ?? []).map((exercise) => (
            <li key={exercise.id} className="passage">
              <MarkdownView>{exercise.prompt}</MarkdownView>
              {open === exercise.id ? (
                <MarkdownView>{exercise.answer ?? ""}</MarkdownView>
              ) : (
                <Button type="primary" shape="round" onClick={() => setOpen(exercise.id)}>
                  {t("practice.reveal")}
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
    </FocusLayout>
  );
}
