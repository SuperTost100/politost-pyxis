import { useMutation } from "@tanstack/react-query";
import { Button, Input } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { MarkdownView } from "../../components/MarkdownView";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";

export function QuizPage() {
  const { t } = useTranslation();
  const { planId, topicId } = useParams();
  useActiveTime(planId, topicId ?? null);
  const navigate = useNavigate();
  const [picks, setPicks] = useState<Record<string, string>>({});
  const start = useMutation({
    mutationFn: () =>
      topicId
        ? invoke("study.quizStart", { planId: planId ?? "", topicId })
        : invoke("study.diagnosticStart", { planId: planId ?? "" }),
  });
  const submit = useMutation({
    mutationFn: () =>
      invoke("study.quizSubmit", { attemptId: start.data?.attemptId ?? "", picks }),
  });
  const questions = start.data?.questions ?? [];

  return (
    <FocusLayout
      title={t("quiz.title")}
      secondary={
        <Button type="text" shape="round" onClick={() => navigate(`/plans/${planId ?? ""}`)}>
          {t("nav.back")}
        </Button>
      }
    >
      {questions.length === 0 ? (
        <Button type="primary" shape="round" loading={start.isPending} onClick={() => start.mutate()}>
          {t("quiz.start")}
        </Button>
      ) : (
        <ol className="choice-list">
          {questions.map((question) => (
            <li key={question.id} className="passage">
              <MarkdownView>{question.stem}</MarkdownView>
              <Input
                aria-label={t("quiz.submit")}
                value={picks[question.id] ?? ""}
                disabled={Boolean(submit.data)}
                onChange={(event) =>
                  setPicks((current) => ({ ...current, [question.id]: event.target.value }))
                }
              />
              {submit.data ? (
                <p className="small">
                  {submit.data.results.find((row) => row.id === question.id)?.expected}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {questions.length > 0 && !submit.data ? (
        <Button type="primary" shape="round" loading={submit.isPending} onClick={() => submit.mutate()}>
          {t("quiz.submit")}
        </Button>
      ) : null}
      {submit.data ? (
        <p className="body-strong">{t("quiz.score", { score: Math.round(submit.data.score * 100) })}</p>
      ) : null}
      {start.error ? <p className="small">{t("quiz.empty")}</p> : null}
    </FocusLayout>
  );
}
