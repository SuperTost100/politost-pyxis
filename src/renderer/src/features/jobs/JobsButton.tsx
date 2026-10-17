import { useQueryClient } from "@tanstack/react-query";
import { App, Button, Popover, Progress } from "antd";
import { ListChecks, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { JobView } from "@shared/ipc";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";
import { jobErrorKey } from "./jobErrors";
import { useJobs } from "./queries";

function stepText(label: string, t: (key: string) => string): string {
  return t(label);
}

function JobList({ jobs }: { jobs: JobView[] }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const client = useQueryClient();
  // A job that changed meanwhile, or a core that restarted, refuses the action. Say so and show the list as it is now.
  const act = (
    request: "jobs.cancel" | "jobs.retry" | "jobs.resume" | "jobs.dismiss",
    jobId: string,
  ) =>
    void invoke(request, { jobId }).catch(() => {
      void message.error(t("jobs.actionFailed"));
      void client.invalidateQueries({ queryKey: ["jobs"] });
    });
  const stateText = (job: JobView) =>
    job.stepLabel ? stepText(job.stepLabel, t) : t(`jobs.state.${job.state}`);
  return (
    <ul className="job-list">
      {jobs.map((job) => (
        <li key={job.id}>
          <div className="job-row">
            <span className="job-text">
              {job.title ? (
                <span className="body-strong job-title">{job.title}</span>
              ) : null}
              <span>{stateText(job)}</span>
            </span>
            {job.state === "queued" || job.state === "running" ? (
              <Button
                type="text"
                size="small"
                onClick={() => act("jobs.cancel", job.id)}
              >
                {t("jobs.cancel")}
              </Button>
            ) : null}
            {job.state === "failed" || job.state === "cancelled" ? (
              <span className="job-actions">
                <Button
                  type="text"
                  size="small"
                  onClick={() => act("jobs.retry", job.id)}
                >
                  {t("jobs.retry")}
                </Button>
                <Button
                  type="text"
                  size="small"
                  onClick={() => act("jobs.dismiss", job.id)}
                >
                  {t("jobs.dismiss")}
                </Button>
              </span>
            ) : null}
            {job.state === "interrupted" ? (
              <span className="job-actions">
                <Button
                  type="text"
                  size="small"
                  onClick={() => act("jobs.resume", job.id)}
                >
                  {t("jobs.resume")}
                </Button>
                <Button
                  type="text"
                  size="small"
                  onClick={() => act("jobs.dismiss", job.id)}
                >
                  {t("jobs.dismiss")}
                </Button>
              </span>
            ) : null}
          </div>
          {job.error ? (
            <Notice tone="danger" details={job.error.slice(0, 2000)}>
              {t(jobErrorKey(job.error))}
            </Notice>
          ) : null}
          {job.state === "running" || job.state === "queued" ? (
            <Progress
              percent={Math.round(job.progress * 100)}
              showInfo={false}
              aria-label={
                job.title ? `${job.title}: ${stateText(job)}` : stateText(job)
              }
              size="small"
              strokeColor="var(--primary)"
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function JobsButton() {
  const { t } = useTranslation();
  const { data: jobs = [] } = useJobs();
  if (jobs.length === 0) return null;
  const spinning = jobs.some(
    (job) => job.state === "running" || job.state === "queued",
  );
  return (
    <Popover
      trigger="click"
      content={
        <section
          role="region"
          aria-label={t("jobs.label", { count: jobs.length })}
        >
          <JobList jobs={jobs} />
        </section>
      }
    >
      <Button
        type="text"
        shape="round"
        aria-label={t("jobs.label", { count: jobs.length })}
      >
        <span className="jobs-trigger">
          {spinning ? (
            <LoaderCircle className="px-spin" size={16} strokeWidth={1.75} />
          ) : (
            <ListChecks size={16} strokeWidth={1.75} />
          )}
          <span className="meta jobs-count">{jobs.length}</span>
        </span>
      </Button>
    </Popover>
  );
}
