import { useQueryClient } from "@tanstack/react-query";
import { App, Progress } from "antd";
import { ChevronDown, Info, Lock, LogIn, Pause, CircleAlert } from "lucide-react";
import { forwardRef, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { JobView } from "@shared/ipc";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { useEngineError } from "../../lib/engineError";
import { invoke } from "../../lib/ipc";
import {
  finishedLabelKey,
  jobContext,
  runningLabelKey,
  type JobGroups,
  type Problem,
  type ProblemKind,
} from "./jobGroups";
import "./JobsPanel.css";

type Act = (
  request: "jobs.cancel" | "jobs.retry" | "jobs.resume" | "jobs.dismiss",
  jobs: JobView[],
) => void;

const PROBLEM_ICONS = {
  engine: LogIn,
  "locked-pdf": Lock,
  interrupted: Pause,
  retry: CircleAlert,
} satisfies Record<ProblemKind, unknown>;

/**
 * What a running job does, naming its topic for study work ("Writing the lesson on Vectors"); other kinds say the step
 * they are at.
 */
function useJobDoing() {
  const { t } = useTranslation();
  return (job: JobView) => {
    const key = runningLabelKey(job.kind);
    if (key) return t(key, { context: jobContext(job), topic: job.topic });
    return job.stepLabel ? t(job.stepLabel) : t(`jobs.state.${job.state}`);
  };
}

/** Where a job belongs, under what it does: the file or exam it works on, and the exam of study work. */
function jobWhere(job: JobView): string {
  return [job.title, job.exam].filter(Boolean).join(" · ");
}

/** What the student calls a job: the file or exam it works on, else what it does. */
function useJobName() {
  const doing = useJobDoing();
  return (job: JobView) => job.title || doing(job);
}

function ProblemCard({
  problem,
  act,
  onUnlock,
  onNavigate,
}: {
  problem: Problem;
  act: Act;
  onUnlock: (job: JobView) => void;
  onNavigate: (to: string) => void;
}) {
  const { t } = useTranslation();
  const nameOf = useJobName();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { jobs, kind, messageKey, engine } = problem;
  // A refused sign-in names its engine, and its sign-in replaces the general way to the engines page.
  const describeEngineError = useEngineError(onNavigate);
  const engineFailure = describeEngineError(messageKey, engine, {
    count: jobs.length,
  });
  const first = jobs[0]!;
  const many = jobs.length > 1;
  const Mark = PROBLEM_ICONS[kind];
  const named = (action: string) =>
    many
      ? undefined
      : t("jobs.actionOn", { action, name: nameOf(first) });
  // A raw error is shown once for the whole group, behind a toggle, for a student who wants to tell support.
  const raw = [
    ...new Set(
      jobs.flatMap((job) =>
        job.error && job.error !== "demo-step-failed"
          ? [job.error.slice(0, 2000)]
          : [],
      ),
    ),
  ];
  const retry = (
    <Button
      key="retry"
      size="sm"
      variant={kind === "retry" ? "secondary" : "ghost"}
      aria-label={named(t("jobs.retry"))}
      onClick={() => act("jobs.retry", jobs)}
    >
      {many ? t("jobs.retryAll") : t("jobs.retry")}
    </Button>
  );
  return (
    <li className="px-jobs-problem">
      <Mark className="px-jobs-problem-mark" size={20} strokeWidth={1.75} aria-hidden />
      <p className="px-jobs-what">
        {many
          ? t(`jobs.problem.many.${first.state}`, { count: jobs.length })
          : t(`jobs.problem.one.${first.state}`, { name: nameOf(first) })}
      </p>
      <p className="px-jobs-why">{engineFailure.text}</p>
      <div className="px-jobs-acts">
        {kind === "locked-pdf" ? (
          <Button
            size="sm"
            variant="secondary"
            aria-label={
              first.title
                ? t("sources.pdfPassword.enterNamed", { title: first.title })
                : undefined
            }
            onClick={() => onUnlock(first)}
          >
            {t("sources.pdfPassword.enter")}
          </Button>
        ) : null}
        {kind === "engine" ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={
              engineFailure.action?.onClick ??
              (() => onNavigate("/settings/engines"))
            }
          >
            {engineFailure.action?.label ?? t("jobs.openEngines")}
          </Button>
        ) : null}
        {kind === "interrupted" ? (
          <Button
            size="sm"
            variant="secondary"
            aria-label={named(t("jobs.resume"))}
            onClick={() => act("jobs.resume", jobs)}
          >
            {many ? t("jobs.resumeAll") : t("jobs.resume")}
          </Button>
        ) : null}
        {kind === "retry" || kind === "engine" ? retry : null}
        <Button
          size="sm"
          variant="ghost"
          aria-label={named(t("jobs.dismiss"))}
          onClick={() => act("jobs.dismiss", jobs)}
        >
          {many ? t("jobs.dismissAll") : t("jobs.dismiss")}
        </Button>
        {many ? (
          <button
            type="button"
            className="px-jobs-disclose"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((value) => !value)}
          >
            {open
              ? t("jobs.hideJobs")
              : t("jobs.showJobs", { count: jobs.length })}
            <ChevronDown
              size={16}
              strokeWidth={1.75}
              aria-hidden
              className={open ? "px-jobs-caret is-open" : "px-jobs-caret"}
            />
          </button>
        ) : null}
      </div>
      {many && open ? (
        <ul className="px-jobs-affected" id={listId}>
          {jobs.map((job) => (
            <li key={job.id}>{nameOf(job)}</li>
          ))}
        </ul>
      ) : null}
      {raw.length > 0 ? (
        <details className="px-jobs-tech">
          <summary>{t("jobs.technical")}</summary>
          <pre className="code" tabIndex={0} aria-label={t("jobs.technical")}>
            {raw.join("\n\n")}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

function RunningRow({ job, act }: { job: JobView; act: Act }) {
  const { t } = useTranslation();
  const nameOf = useJobName();
  const what = useJobDoing()(job);
  const where = jobWhere(job);
  return (
    <li className="px-jobs-row">
      <Icon
        name={job.state === "running" ? "loader-circle" : "clock"}
        size={20}
        className={
          job.state === "running" ? "px-jobs-mark px-spin" : "px-jobs-mark"
        }
      />
      <div className="px-jobs-body">
        <p className="px-jobs-what">{what}</p>
        {where || job.state === "queued" ? (
          <p className="px-jobs-sub">
            {[job.state === "queued" ? t("jobs.state.queued") : "", where].filter(Boolean).join(" · ")}
          </p>
        ) : null}
        <Progress
          percent={Math.round(job.progress * 100)}
          showInfo={false}
          aria-label={where ? `${what}, ${where}` : what}
          size="small"
          strokeColor="var(--primary)"
        />
      </div>
      {/* Work a page does itself stops on that page. */}
      {job.inPage ? null : (
        <IconButton
          icon="x"
          size="sm"
          variant="ghost"
          label={t("jobs.actionOn", { action: t("jobs.cancel"), name: nameOf(job) })}
          onClick={() => act("jobs.cancel", [job])}
        />
      )}
    </li>
  );
}

function FinishedRow({ job, act }: { job: JobView; act: Act }) {
  const { t, i18n } = useTranslation();
  const what = t(finishedLabelKey(job.kind) ?? "jobs.state.succeeded", {
    context: jobContext(job),
    topic: job.topic,
  });
  const where = jobWhere(job);
  const at = new Date(job.updatedAt);
  const time = new Intl.DateTimeFormat(i18n.language, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
  return (
    <li className="px-jobs-row">
      <Icon name="circle-check" size={20} className="px-jobs-mark is-done" />
      <div className="px-jobs-body">
        <p className="px-jobs-what">{what}</p>
        <p className="px-jobs-sub">
          {where ? `${where} · ` : ""}
          <time dateTime={at.toISOString()}>{time}</time>
        </p>
        {job.fallback ? (
          <p className="px-jobs-note">
            <Info size={16} strokeWidth={1.75} aria-hidden />
            <span>
              {t(`engines.fallback.${job.fallback.reason}`, {
                from: job.fallback.from,
                to: job.fallback.to,
              })}
            </span>
          </p>
        ) : null}
      </div>
      <IconButton
        icon="x"
        size="sm"
        variant="ghost"
        label={t("jobs.actionOn", {
          action: t("jobs.dismiss"),
          name: where ? `${what}, ${where}` : what,
        })}
        onClick={() => act("jobs.dismiss", [job])}
      />
    </li>
  );
}

/**
 * The jobs list: what needs fixing first, then what is running, then what finished today. The root takes focus when
 * the list opens, so the keyboard reaches its buttons without tabbing through the page behind it.
 */
export const JobsPanel = forwardRef<
  HTMLElement,
  {
    groups: JobGroups;
    /** Asks for the password of a locked PDF whose import stopped. */
    onUnlock: (job: JobView) => void;
    /** Closes the list, after it sent the student to another page. */
    onClose: () => void;
    onEscape: () => void;
  }
>(function JobsPanel({ groups, onUnlock, onClose, onEscape }, ref) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const client = useQueryClient();
  const navigate = useNavigate();
  const headId = useId();
  // A job that changed meanwhile, or a core that restarted, refuses the action. Say so and show the list as it is now.
  const act: Act = (request, jobs) => {
    void Promise.all(jobs.map((job) => invoke(request, { jobId: job.id }))).catch(
      () => {
        void message.error(t("jobs.actionFailed"));
        void client.invalidateQueries({ queryKey: ["jobs"] });
        void client.invalidateQueries({ queryKey: ["jobs-finished"] });
      },
    );
  };
  const { problems, running, finished } = groups;
  return (
    <section
      ref={ref}
      className="px-jobs"
      aria-labelledby={headId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onEscape();
        }
      }}
    >
      <header className="px-jobs-head">
        <h2 id={headId}>{t("jobs.title")}</h2>
        {finished.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => act("jobs.dismiss", finished)}
          >
            {t("jobs.clearDone")}
          </Button>
        ) : null}
      </header>
      {problems.length > 0 ? (
        <GroupSection title={t("jobs.group.toFix", { count: problems.length })}>
          {problems.map((problem) => (
            <ProblemCard
              key={problem.key}
              problem={problem}
              act={act}
              onUnlock={onUnlock}
              onNavigate={(to) => {
                onClose();
                void navigate(to);
              }}
            />
          ))}
        </GroupSection>
      ) : null}
      {running.length > 0 ? (
        <GroupSection title={t("jobs.group.running", { count: running.length })}>
          {running.map((job) => (
            <RunningRow key={job.id} job={job} act={act} />
          ))}
        </GroupSection>
      ) : null}
      {finished.length > 0 ? (
        <GroupSection title={t("jobs.group.done", { count: finished.length })}>
          {finished.map((job) => (
            <FinishedRow key={job.id} job={job} act={act} />
          ))}
        </GroupSection>
      ) : null}
    </section>
  );
});

function GroupSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="px-jobs-group" aria-labelledby={id}>
      <h3 className="label" id={id}>
        {title}
      </h3>
      <ul className="px-jobs-list">{children}</ul>
    </section>
  );
}
