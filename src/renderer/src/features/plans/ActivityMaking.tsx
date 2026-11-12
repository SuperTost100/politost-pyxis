import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Logo } from "../../components/Logo";
import { invoke } from "../../lib/ipc";
import { SETTLED, simulationSettled, type MadeActivity } from "./making";

/**
 * Adesso while Crea's quiz or simulation is being written: the working mark and what Pyxis is doing, in the card where
 * the exam's next step usually is. Once the quiz has its first questions, or the simulation is prepared, it opens; if the
 * writing stops, it opens anyway, and the page there says what happened and offers to try again. Leaving the exam page
 * leaves the work running, and "Da finire" lists it.
 */
export function ActivityMaking({
  planId,
  made,
  onDone,
}: {
  planId: string;
  made: MadeActivity;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const card = useRef<HTMLElement>(null);
  // The same reads the quiz and simulation pages make, so they open with what is already known.
  const quiz = useQuery({
    queryKey: ["quiz-session", made.kind === "quiz" ? made.attemptId : ""],
    queryFn: () =>
      invoke("study.quizRead", {
        attemptId: made.kind === "quiz" ? made.attemptId : "",
        planId,
      }),
    enabled: made.kind === "quiz",
    refetchInterval: 500,
  });
  const build = useQuery({
    queryKey: ["simulation-build", planId],
    queryFn: () => invoke("study.simulationBuild", { planId }),
    enabled: made.kind === "simulation",
    refetchInterval: 1000,
  });
  // A read that fails opens the page too, which reads again and says what went wrong.
  const ready =
    made.kind === "quiz"
      ? quiz.isError ||
        Boolean(
          quiz.data &&
          (quiz.data.questions.length > 0 || SETTLED.includes(quiz.data.state)),
        )
      : simulationSettled(made.jobId, build);
  useEffect(() => {
    if (!ready) return;
    onDone();
    void client.invalidateQueries({ queryKey: ["unfinished", planId] });
    navigate(
      made.kind === "quiz"
        ? `/plans/${planId}/quiz/${made.topicId}?attempt=${encodeURIComponent(made.attemptId)}`
        : `/plans/${planId}/simulation`,
    );
  }, [ready]);
  // The card's content changes in place, from the dialog that just shrank back into the page.
  useEffect(() => {
    if (
      !card.current ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    card.current.animate(
      [
        { opacity: 0.4, transform: "scale(0.985)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 260, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
    );
  }, []);
  const progress = build.data?.progress ?? 0;
  return (
    <section
      className="px-exam-now is-working"
      ref={card}
      aria-labelledby="px-exam-now-title"
    >
      <Logo working decorative size={44} />
      <div className="px-exam-now-text" role="status">
        <span className="px-exam-kicker">{t("plans.path.next")}</span>
        <h2 id="px-exam-now-title">
          {made.kind === "quiz"
            ? t("examPage.making.quiz", { topic: made.topicTitle })
            : t("examPage.making.simulation")}
        </h2>
        <p>
          {made.kind === "quiz"
            ? t("examPage.making.quizLine")
            : t("examPage.making.simulationLine", {
                percent: Math.round(progress * 100),
              })}
        </p>
      </div>
    </section>
  );
}
