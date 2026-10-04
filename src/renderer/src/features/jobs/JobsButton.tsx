import { Button, Popover, Progress } from "antd";
import { ListChecks, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { JobView } from "@shared/ipc";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";
import { useJobs } from "./queries";

function stepText(label: string, t: (key: string) => string): string {
  return t(label);
}

function errorText(error: string, t: (key: string) => string): string {
  return error === "demo-step-failed"
    ? t("jobs.demoFailed")
    : error.includes("engine-missing")
      ? t("engines.errors.engine-missing")
      : t("jobs.failedGeneral");
}

function JobList({ jobs }: { jobs: JobView[] }) {
  const { t } = useTranslation();
  return (
    <ul className="job-list">
      {jobs.map((job) => (
        <li key={job.id}>
          <div className="job-row">
            <span>
              {job.stepLabel
                ? stepText(job.stepLabel, t)
                : t(`jobs.state.${job.state}`)}
            </span>
            {job.state === "queued" || job.state === "running" ? (
              <Button
                type="text"
                size="small"
                onClick={() => void invoke("jobs.cancel", { jobId: job.id })}
              >
                {t("jobs.cancel")}
              </Button>
            ) : null}
            {job.state === "failed" || job.state === "cancelled" ? (
              <span className="job-actions">
                <Button
                  type="text"
                  size="small"
                  onClick={() => void invoke("jobs.retry", { jobId: job.id })}
                >
                  {t("jobs.retry")}
                </Button>
                <Button
                  type="text"
                  size="small"
                  onClick={() => void invoke("jobs.dismiss", { jobId: job.id })}
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
                  onClick={() => void invoke("jobs.resume", { jobId: job.id })}
                >
                  {t("jobs.resume")}
                </Button>
                <Button
                  type="text"
                  size="small"
                  onClick={() => void invoke("jobs.dismiss", { jobId: job.id })}
                >
                  {t("jobs.dismiss")}
                </Button>
              </span>
            ) : null}
          </div>
          {job.error ? (
            <Notice tone="danger" details={job.error.slice(0, 2000)}>
              {errorText(job.error, t)}
            </Notice>
          ) : null}
          {job.state === "running" || job.state === "queued" ? (
            <Progress
              percent={Math.round(job.progress * 100)}
              showInfo={false}
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
