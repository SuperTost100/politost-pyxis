import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MasteryBar } from "../../components/MasteryBar";
import { invoke } from "../../lib/ipc";

/** The mixed review's session, read from the core so every screen shows the same queue and progress. */
export function useReviewSession(planId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["review-session", planId],
    enabled: enabled && Boolean(planId),
    queryFn: () => invoke("study.reviewSession", { planId: planId ?? "" }),
    // A gap drill is built in the background; keep its status fresh while it runs.
    refetchInterval: (query) =>
      query.state.data?.drills.some((drill) =>
        ["queued", "running"].includes(drill.state),
      )
        ? 1500
        : false,
  });
}

/** One progress line over the whole review: its cards, then its questions, plus the drill questions still owed. */
export function ReviewProgress({
  progress,
}: {
  progress: {
    done: number;
    total: number;
    cardsTotal: number;
    questionsTotal: number;
    questionsPending: number;
  };
}) {
  const { t } = useTranslation();
  if (progress.total === 0) return null;
  return (
    <div className="px-review-progress">
      <p className="small">
        {t(
          progress.questionsPending > 0
            ? "cards.reviewProgressPending"
            : "cards.reviewProgress",
          {
            done: progress.done,
            total: progress.total,
            cards: progress.cardsTotal,
            questions: progress.questionsTotal,
            pending: progress.questionsPending,
          },
        )}
      </p>
      <MasteryBar
        tone="primary"
        showValue={false}
        value={(progress.done / progress.total) * 100}
        label={t("cards.reviewProgressLabel")}
      />
    </div>
  );
}
