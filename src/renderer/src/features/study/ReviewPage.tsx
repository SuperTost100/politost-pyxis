import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Segmented } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";
import { ReviewProgress, useReviewSession } from "./ReviewProgress";

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
  return (
    <FocusLayout
      title={t("cards.reviewTitle")}
      secondary={
        <Button
          type="text"
          shape="round"
          onClick={() => navigate(`/plans/${planId}`)}
        >
          {t("nav.back")}
        </Button>
      }
    >
      <p className="body">{t("cards.reviewIntro")}</p>
      {start.isError ? (
        <Notice tone="danger">{t("cards.reviewFailed")}</Notice>
      ) : null}
      {empty ? <Notice tone="info">{t("cards.reviewEmpty")}</Notice> : null}
      {active ? (
        <>
          <p className="body">{t("cards.reviewResume")}</p>
          <ReviewProgress progress={active.progress} />
        </>
      ) : (
        <div className="px-review-count">
          <p className="label" id="review-count">
            {t("cards.reviewCount")}
          </p>
          <Segmented
            aria-labelledby="review-count"
            options={COUNTS}
            value={count}
            onChange={(value) => setCount(Number(value))}
          />
        </div>
      )}
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
      <div className="px-review-actions">
        <Button
          type="primary"
          shape="round"
          loading={start.isPending}
          disabled={active?.next === "waiting"}
          onClick={() => (active ? go(active) : start.mutate())}
        >
          {t(active ? "cards.reviewContinue" : "cards.reviewStart")}
        </Button>
        {active ? (
          <Button
            type="text"
            shape="round"
            loading={discard.isPending}
            onClick={() => discard.mutate()}
          >
            {t("cards.reviewDiscard")}
          </Button>
        ) : null}
      </div>
    </FocusLayout>
  );
}
