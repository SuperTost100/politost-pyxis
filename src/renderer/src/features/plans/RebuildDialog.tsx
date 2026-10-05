import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Modal } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../lib/ipc";
import { Notice } from "../../components/Notice";
import { StepLines } from "../../components/StepLines";

/**
 * PLAN-13: one durable job builds the new topic tree and matches it to the plan.
 * The student reviews kept, new and archived topics, and Apply writes exactly that review.
 */
export function RebuildDialog({
  planId,
  open,
  onClose,
  onDone,
}: {
  planId: string;
  /** Kept for the existing caller; the job reads the plan's sources itself. */
  sourceIds?: string[];
  open: boolean;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const key = ["plan-rebuild", planId];
  const state = useQuery({
    queryKey: key,
    enabled: open,
    gcTime: 0,
    queryFn: () => invoke("plans.rebuildState", { planId }),
    refetchInterval: (query) =>
      ["queued", "running"].includes(query.state.data?.state ?? "") ? 500 : false,
  });
  const job = state.data;
  const review = job?.review;
  const refresh = () => client.invalidateQueries({ queryKey: key });

  async function act(work: () => Promise<unknown>, done?: () => Promise<void>) {
    setBusy(true);
    setFailed(false);
    try {
      await work();
      await refresh();
      await done?.();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  const start = () => act(() => invoke("plans.rebuildStart", { planId }));
  const discard = () => act(() => invoke("plans.rebuildDiscard", { planId }));
  const restart = () =>
    act(async () => {
      await invoke("plans.rebuildDiscard", { planId });
      await invoke("plans.rebuildStart", { planId });
    });
  const apply = () =>
    act(
      () => invoke("plans.rebuildApply", { planId, jobId: job!.jobId }),
      async () => {
        await onDone();
        onClose();
      },
    );

  const running = job && ["queued", "running"].includes(job.state);
  const stopped =
    job && ["failed", "cancelled", "interrupted"].includes(job.state);
  const footer = !state.isSuccess ? null : !job ? (
    <>
      <Button onClick={onClose}>{t("wizard.cancel")}</Button>
      <Button type="primary" loading={busy} onClick={() => void start()}>
        {t("planOverview.rebuildStart")}
      </Button>
    </>
  ) : running ? (
    <>
      <Button onClick={onClose}>{t("planOverview.rebuildBackground")}</Button>
      <Button
        onClick={() =>
          void act(() => invoke("jobs.cancel", { jobId: job.jobId }))
        }
      >
        {t("planOverview.rebuildStop")}
      </Button>
    </>
  ) : stopped ? (
    <>
      <Button disabled={busy} onClick={() => void discard()}>
        {t("planOverview.rebuildDiscard")}
      </Button>
      <Button
        type="primary"
        loading={busy}
        onClick={() =>
          void act(() =>
            invoke(
              job.state === "interrupted" ? "jobs.resume" : "jobs.retry",
              { jobId: job.jobId },
            ),
          )
        }
      >
        {t(
          job.state === "interrupted"
            ? "planOverview.rebuildResume"
            : "planOverview.rebuildRetry",
        )}
      </Button>
    </>
  ) : review?.stale ? (
    <>
      <Button disabled={busy} onClick={() => void discard()}>
        {t("planOverview.rebuildDiscard")}
      </Button>
      <Button type="primary" loading={busy} onClick={() => void restart()}>
        {t("planOverview.rebuildAgain")}
      </Button>
    </>
  ) : (
    <>
      <Button disabled={busy} onClick={() => void discard()}>
        {t("planOverview.rebuildDiscard")}
      </Button>
      <Button type="primary" loading={busy} onClick={() => void apply()}>
        {t("planOverview.rebuildApply")}
      </Button>
    </>
  );

  return (
    <Modal
      open={open}
      title={t("plans.rebuild")}
      onCancel={onClose}
      footer={footer}
      destroyOnHidden
    >
      {failed || state.isError ? (
        <Notice tone="danger">{t("planOverview.failed")}</Notice>
      ) : null}
      {state.isPending ? (
        <p className="small" role="status">
          {t("planOverview.rebuildLoading")}
        </p>
      ) : !job ? (
        <p className="small">{t("planOverview.rebuildIntro")}</p>
      ) : running || stopped ? (
        <div className="px-rebuild-diff">
          <StepLines
            label={t("plans.rebuild")}
            steps={job.steps.map((step) => ({
              id: step.name,
              label: t(step.label),
              state: step.state === "succeeded" ? "done" : step.state,
            }))}
          />
          {stopped ? (
            <Notice tone={job.state === "failed" ? "danger" : "warning"}>
              {t(`planOverview.rebuild_${job.state}`)}
            </Notice>
          ) : null}
        </div>
      ) : review ? (
        // The list scrolls inside the dialog, so the keyboard needs a way in.
        <div className="px-rebuild-diff" role="region" aria-label={t("plans.rebuild")} tabIndex={0}>
          {review.stale ? (
            <Notice tone="warning">{t("planOverview.rebuildStale")}</Notice>
          ) : null}
          <section aria-labelledby="rebuild-kept">
            <h2 id="rebuild-kept" className="label">
              {t("planOverview.rebuildKept", { count: review.kept.length })}
            </h2>
            <ul>
              {review.kept.map((topic) => (
                <li key={topic.id}>
                  <span className="body-strong">{topic.title}</span>
                  <span className="small ink-muted">
                    {t(`planOverview.rebuildKept_${topic.reason}`, {
                      percent: Math.round(topic.score * 100),
                    })}
                  </span>
                  {topic.newTitle && topic.newTitle !== topic.title ? (
                    <span className="small ink-muted">
                      {t("planOverview.rebuildKeptRenamed", {
                        title: topic.newTitle,
                      })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="rebuild-new">
            <h2 id="rebuild-new" className="label">
              {t("planOverview.rebuildNew", { count: review.added.length })}
            </h2>
            {review.added.length ? (
              <ul>
                {review.added.map((topic) => (
                  <li key={topic.title}>
                    <span className="body-strong">{topic.title}</span>
                    <span className="small ink-muted">
                      {t("planOverview.rebuildNewPassages", {
                        count: topic.passages,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small ink-muted">
                {t("planOverview.rebuildNoneNew")}
              </p>
            )}
          </section>
          <section aria-labelledby="rebuild-archived">
            <h2 id="rebuild-archived" className="label">
              {t("planOverview.rebuildArchived", {
                count: review.archived.length,
              })}
            </h2>
            {review.archived.length ? (
              <ul>
                {review.archived.map((topic) => (
                  <li key={topic.id}>
                    <span className="body-strong">{topic.title}</span>
                    <span className="small ink-muted">
                      {t(
                        topic.progress
                          ? "planOverview.rebuildArchived_progress"
                          : "planOverview.rebuildArchived_empty",
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small ink-muted">
                {t("planOverview.rebuildNoneArchived")}
              </p>
            )}
          </section>
          <p className="small ink-muted">
            {t("planOverview.rebuildNoArchive")}
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
