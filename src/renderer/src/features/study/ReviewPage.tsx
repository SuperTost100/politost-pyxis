import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";
import { ActivityChoice, ActivityIntro, type ActivityFact } from "./ActivityIntro";
import { ReviewProgress, useReviewSession } from "./ReviewProgress";
import { usePlan, useRecommend } from "../../lib/queries";

const COUNTS = [5, 10, 20];

/** What the review says about a drill job that has not delivered, and the job control that recovers it. */
const DRILL_STATES: Record<
  string,
  {
    key: string;
    tone: "info" | "warning" | "danger";
    action?: "jobs.cancel" | "jobs.retry" | "jobs.resume";
    /** A drill that can still block the finish offers going on without it. */
    skip?: boolean;
  }
> = {
  queued: { key: "Building", tone: "info", action: "jobs.cancel" },
  running: { key: "Building", tone: "info", action: "jobs.cancel" },
  interrupted: { key: "Interrupted", tone: "warning", action: "jobs.resume", skip: true },
  failed: { key: "Failed", tone: "danger", action: "jobs.retry", skip: true },
  cancelled: { key: "Cancelled", tone: "info", action: "jobs.retry" },
  skipped: { key: "Skipped", tone: "info" },
};

/**
 * LES-13. The core stores one mixed review (its cards, its question attempt and a gap drill
 * job per empty gap). Starting resumes the unfinished review instead of building another; the
 * card screen and the quiz screen read the same session, so reloads never change the queue.
 * A finished drill's questions join the same attempt, so the review stays one queue.
 */
export function ReviewPage() {
  const { t } = useTranslation();
  const { planId = "" } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [count, setCount] = useState(20);
  const saved = useReviewSession(planId);
  const plan = usePlan(planId);
  const guide = useRecommend(planId);
  const start = useMutation({
    mutationFn: () => invoke("study.review", { planId, count }),
    onSuccess: (session) => {
      void client.invalidateQueries({ queryKey: ["review-session", planId] });
      if (session.next !== "done") go(session);
    },
  });
  // Recovery for a gap drill uses the job's own cancel, retry and resume.
  const control = useMutation({
    mutationFn: async (job: { action: "jobs.cancel" | "jobs.retry" | "jobs.resume" | "skip"; jobId: string }) => {
      if (job.action === "skip") await invoke("study.reviewSkipDrill", { planId, jobId: job.jobId });
      else await invoke(job.action, { jobId: job.jobId });
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["review-session", planId] }),
  });
  const discard = useMutation({
    mutationFn: () => invoke("study.reviewDiscard", { planId }),
    onSuccess: () => {
      start.reset();
      return client.invalidateQueries({ queryKey: ["review-session", planId] });
    },
  });
  function go(session: { next: "cards" | "questions" | "waiting" | "done"; attemptId: string }) {
    if (session.next === "cards") navigate(`/plans/${planId}/review/cards`);
    else if (session.next === "questions")
      navigate(
        `/plans/${planId}/diagnostic?attempt=${encodeURIComponent(session.attemptId)}`,
      );
  }
  const active = saved.data ?? null;
  const shown = active ?? start.data;
  const empty =
    start.isSuccess && start.data.next === "done" && !start.data.drills.length;
  // What a new review draws on: the flashcards due and the topics with open gaps. A review in progress counts its own.
  const due = guide.data?.topics.reduce((sum, topic) => sum + topic.dueCards, 0) ?? 0;
  const gapTopics = guide.data?.topics.filter((topic) => topic.gaps > 0).length ?? 0;
  const questions = active ? active.progress.questionsTotal + active.progress.questionsPending : 0;
  const facts: ActivityFact[] = active
    ? [
        ...(active.progress.cardsTotal
          ? [
              {
                icon: "layers" as const,
                label: t("cards.factCards", { count: active.progress.cardsTotal }),
              },
            ]
          : []),
        ...(questions
          ? [{ icon: "list-checks" as const, label: t("quiz.factQuestions", { count: questions }) }]
          : []),
      ]
    : [
        ...(due ? [{ icon: "layers" as const, label: t("cards.factDue", { count: due }) }] : []),
        ...(gapTopics
          ? [{ icon: "target" as const, label: t("cards.factGaps", { count: gapTopics }) }]
          : []),
      ];
  return (
    <FocusLayout title={t("cards.reviewTitle")} onClose={() => navigate(`/plans/${planId}`)}>
      <ActivityIntro
        eyebrow={plan.data?.title ?? t("cards.reviewTitle")}
        title={t("cards.reviewTitle")}
        sentence={t("cards.reviewIntro")}
        facts={facts}
        options={
          active ? undefined : (
            <ActivityChoice
              label={t("cards.reviewCount")}
              value={count}
              choices={COUNTS.map((value) => ({ value, label: String(value) }))}
              disabled={start.isPending}
              onChange={setCount}
            />
          )
        }
        startLabel={t(active ? "cards.reviewContinue" : "cards.reviewStart")}
        starting={start.isPending}
        disabled={active?.next === "waiting"}
        onStart={() => (active ? go(active) : start.mutate())}
        onBack={() => navigate(`/plans/${planId}`)}
      >
        {start.isError ? <Notice tone="danger">{t("cards.reviewFailed")}</Notice> : null}
        {empty ? <Notice tone="info">{t("cards.reviewEmpty")}</Notice> : null}
        {active ? (
          <div className="px-review-resume">
            <p className="body">{t("cards.reviewResume")}</p>
            <ReviewProgress progress={active.progress} />
            <Button
              size="small"
              shape="round"
              className="px-review-discard"
              loading={discard.isPending}
              onClick={() => discard.mutate()}
            >
              {t("cards.reviewDiscard")}
            </Button>
          </div>
        ) : null}
        {(shown?.drills ?? []).map((drill) => {
          const recovery = DRILL_STATES[drill.state] ?? DRILL_STATES.failed!;
          return (
            <Notice
              key={drill.jobId}
              tone={recovery.tone}
              action={
                recovery.action
                  ? {
                      label: t(`cards.reviewDrill${recovery.key}Action`),
                      onClick: () => control.mutate({ action: recovery.action!, jobId: drill.jobId }),
                    }
                  : undefined
              }
              secondary={
                recovery.skip
                  ? {
                      label: t("cards.reviewDrillSkip"),
                      onClick: () => control.mutate({ action: "skip", jobId: drill.jobId }),
                    }
                  : undefined
              }
            >
              {t(`cards.reviewDrill${recovery.key}`, { topic: drill.title, count: drill.want })}
            </Notice>
          );
        })}
      </ActivityIntro>
    </FocusLayout>
  );
}
