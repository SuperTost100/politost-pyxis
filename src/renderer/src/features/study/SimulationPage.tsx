import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { MarkdownView } from "../../components/MarkdownView";
import { invoke } from "../../lib/ipc";
import { useActiveTime } from "./activeTime";

export function SimulationPage() {
  const { t } = useTranslation();
  const { planId } = useParams();
  useActiveTime(planId, null);
  const navigate = useNavigate();
  const client = useQueryClient();
  const [started, setStarted] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const open = useQuery({
    queryKey: ["simulation", planId, started],
    enabled: Boolean(planId),
    refetchInterval: 15_000,
    queryFn: () =>
      started
        ? invoke("study.simulationRead", { attemptId: started })
        : invoke("study.simulationOpen", { planId: planId ?? "" }),
  });
  const run = open.data;
  const shown = { ...(run && "picks" in run ? run.picks : {}), ...picks };
  const minutes = run ? Math.ceil(run.leftMs / 60_000) : 30;

  return (
    <FocusLayout
      title={t("simulation.title")}
      meta={run ? t("simulation.left", { minutes }) : undefined}
      closable={!(run && !run.submitted)}
      secondary={
        run && !run.submitted ? undefined : (
          <Button type="text" shape="round" onClick={() => navigate(`/plans/${planId ?? ""}`)}>
            {t("nav.back")}
          </Button>
        )
      }
    >
      {!run ? (
        <Button
          type="primary"
          shape="round"
          onClick={() => {
            if (!planId) return;
            void invoke("study.simulationStart", { planId }).then((next) => {
              setStarted(next.attemptId);
            });
          }}
        >
          {t("simulation.start")}
        </Button>
      ) : (
        <ol className="choice-list">
          {run.questions.map((question) => (
            <li key={question.id} className="passage">
              <MarkdownView>{question.stem}</MarkdownView>
              <input
                aria-label={t("quiz.submit")}
                disabled={run.submitted}
                value={shown[question.id] ?? ""}
                onChange={(event) => {
                  const next = { ...shown, [question.id]: event.target.value };
                  setPicks(next);
                  if (!run || !("attemptId" in run)) return;
                  void invoke("study.simulationDraft", { attemptId: run.attemptId, picks: next });
                }}
              />
            </li>
          ))}
        </ol>
      )}
      {run && !run.submitted ? (
        <Button
          type="primary"
          shape="round"
          onClick={() => {
            void invoke("study.quizSubmit", { attemptId: run.attemptId, picks: shown }).then(() => {
              void client.invalidateQueries({ queryKey: ["simulation", planId] });
            });
          }}
        >
          {t("quiz.submit")}
        </Button>
      ) : null}
      {run?.submitted ? (
        <section>
          <p className="small">{t("simulation.localGrade")}</p>
          <h2 className="body-strong">{t("simulation.byTopic")}</h2>
          <ul className="choice-list">
            {run.topics.map((topic) => (
              <li key={topic.id} className="small">
                {topic.title} · {Math.round(topic.score * 100)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {open.error ? <p className="small">{t("simulation.empty")}</p> : null}
    </FocusLayout>
  );
}
