import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../lib/ipc";
import { Dialog, type DialogAction } from "../../components/Dialog";
import { Notice } from "../../components/Notice";
import { StepLines } from "../../components/StepLines";
import { Working } from "../../components/Working";

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
  // Annulla closes the dialog and leaves the job as it is; Scarta is the extra action on the left that drops it.
  const rebuildCancel = running ? t("planOverview.rebuildBackground") : undefined;
  const discardAction: DialogAction = {
    label: t("planOverview.rebuildDiscard"),
    tone: "secondary",
    side: "start",
    onClick: () => void discard(),
  };
  const actions: DialogAction[] = !state.isSuccess
    ? []
    : !job
      ? [{ label: t("planOverview.rebuildStart"), working: busy, onClick: () => void start() }]
      : running
        ? [
            {
              label: t("planOverview.rebuildStop"),
              tone: "secondary",
              onClick: () => void act(() => invoke("jobs.cancel", { jobId: job.jobId })),
            },
          ]
        : stopped
          ? [
              discardAction,
              {
                label: t(job.state === "interrupted" ? "planOverview.rebuildResume" : "planOverview.rebuildRetry"),
                working: busy,
                onClick: () =>
                  void act(() =>
                    invoke(job.state === "interrupted" ? "jobs.resume" : "jobs.retry", { jobId: job.jobId }),
                  ),
              },
            ]
          : review?.stale
            ? [discardAction, { label: t("planOverview.rebuildAgain"), working: busy, onClick: () => void restart() }]
            : [discardAction, { label: t("planOverview.rebuildApply"), working: busy, onClick: () => void apply() }];

  return (
    <Dialog
      open={open}
      width="lg"
      title={t("plans.rebuild")}
      cancel={rebuildCancel}
      busy={busy}
      onClose={onClose}
      actions={actions}
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
          {running ? (
            // The result will appear in this body, so Pyxis works here, saying which step it is on.
            <Working
              slot
              line={t(
                job.steps.find((step) => step.state === "running")?.label ?? "planOverview.rebuildWorking",
              )}
            />
          ) : null}
          {job.steps.length > 0 ? (
            <StepLines
              label={t("plans.rebuild")}
              steps={job.steps.map((step) => ({
                id: step.name,
                label: t(step.label),
                state: step.state === "succeeded" ? "done" : step.state,
              }))}
            />
          ) : null}
          {stopped ? (
            <Notice tone={job.state === "failed" ? "danger" : "warning"}>
              {t(`planOverview.rebuild_${job.state}`)}
            </Notice>
          ) : null}
        </div>
      ) : review ? (
        <div className="px-rebuild-diff" role="region" aria-label={t("plans.rebuild")}>
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
    </Dialog>
  );
}
