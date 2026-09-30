import { useQuery } from "@tanstack/react-query";
import { Button } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { MarkdownView } from "../../components/MarkdownView";
import { invoke } from "../../lib/ipc";

export function PracticePage() {
  const { t } = useTranslation();
  const { planId, topicId } = useParams();
  const navigate = useNavigate();
  const [open, setOpen] = useState<string | null>(null);
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
