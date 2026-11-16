import { useQueryClient } from "@tanstack/react-query";
import { App } from "antd";
import { Info, Lock, LogIn, Pause, CircleAlert, Search } from "lucide-react";
import { forwardRef, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { currentToolLabel } from "@shared/tool-names";
import { useNavigate } from "react-router";
import type { InstallableProvider } from "@shared/installers";
import type { JobView } from "@shared/ipc";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { Logo } from "../../components/Logo";
import { useEngineError } from "../../lib/engineError";
import { invoke } from "../../lib/ipc";
import { limitWhen } from "../../lib/toolOrder";
import {
  finishedLabelKey,
  jobContext,
  jobTopicName,
  requestPath,
  runningLabelKey,
  type JobBatch,
  type JobGroups,
  type Problem,
  type ProblemKind,
} from "./jobGroups";
import { JobDebug } from "./JobDebug";
import { jobErrorEngine } from "./jobErrors";
import type { ToolLimits } from "./outOfRequests";
import "./JobsPanel.css";

type Act = (
  request: "jobs.cancel" | "jobs.retry" | "jobs.resume" | "jobs.dismiss" | "jobs.resumeAll",
  jobs: JobView[],
) => void;

const PROBLEM_ICONS = {
  engine: LogIn,
  "locked-pdf": Lock,
  interrupted: Pause,
  stopped: Pause,
  retry: CircleAlert,
  "nothing-found": Search,
  "out-of-requests": CircleAlert,
} satisfies Record<ProblemKind, unknown>;

/** How many of a request's jobs its row names when it opens; the rest are counted. */
const BATCH_NAMED = 5;

/** The wording of a request's row, by the kind its jobs share. Other kinds use what their first job does. */
const BATCH_WORDS: Record<string, string> = {
  "source-import": "read",
  "source-index": "index",
};

/** How far a job is, as a 4 px bar under its line. */
function Bar({ value, label }: { value: number; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span
      className="px-jobs-bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <i style={{ width: `${percent}%` }} />
    </span>
  );
}

/** The mark of a job in the list: the Pyxis mark at work while it runs, a clock while it waits. */
function RunningMark({ running }: { running: boolean }) {
  return running ? (
    <span className="px-jobs-mark is-working">
      <Logo size={20} working decorative />
    </span>
  ) : (
    <Icon name="clock" size={20} className="px-jobs-mark" />
  );
}

/**
 * What a running job does, naming its topic for study work ("Writing the lesson on Vectors"); other kinds say the step
 * they are at.
 */
function useJobDoing() {
  const { t } = useTranslation();
  const topicOf = useJobTopic();
  return (job: JobView) => {
    const key = runningLabelKey(job.kind);
    // A folder being read counts the files found so far.
    if (key) return t(key, { context: jobContext(job), topic: topicOf(job), ...(job.count === undefined ? {} : { count: job.count }) });
    return job.stepLabel ? t(job.stepLabel) : t(`jobs.state.${job.state}`);
  };
}

/** The topic a job's wording names, a Review's topics as a short list. */
function useJobTopic() {
  const { t, i18n } = useTranslation();
  return (job: JobView) =>
    jobTopicName(job, i18n.language, (first, others) => t("jobs.topicsMore", { first, count: others }));
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
  blocked,
}: {
  problem: Problem;
  act: Act;
  onUnlock: (job: JobView) => void;
  onNavigate: (to: string, state?: object) => void;
  /** Why the page cannot be left: what leads elsewhere is off, and says so. */
  blocked?: string;
}) {
  const { t } = useTranslation();
  const nameOf = useJobName();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { jobs, kind, messageKey, engine } = problem;
  if (kind === "nothing-found") return <RequestCard job={jobs[0]!} messageKey={messageKey} act={act} onNavigate={onNavigate} blocked={blocked} />;
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
            disabled={Boolean(blocked)}
            title={blocked}
            onClick={
              engineFailure.action?.onClick ??
              (() => onNavigate("/settings/engines"))
            }
          >
            {engineFailure.action?.label ?? t("settings.enginesTitle")}
          </Button>
        ) : null}
        {kind === "interrupted" || kind === "stopped" ? (
          <Button
            size="sm"
            variant="secondary"
            aria-label={named(t("jobs.resume"))}
            onClick={() => act("jobs.resumeAll", jobs)}
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
            <span className="px-chevron px-jobs-caret" aria-hidden />
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
      {jobs.slice(0, 3).map((job) => (
        <JobDebug key={job.id} jobId={job.id} running={false} />
      ))}
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

/**
 * A request that read the material and found nothing. It did not fail, so it has no retry and no technical details: it
 * waits for the student to change the request on the page it leads to, or to dismiss it.
 */
function RequestCard({
  job,
  messageKey,
  act,
  onNavigate,
  blocked,
}: {
  job: JobView;
  messageKey: string;
  act: Act;
  onNavigate: (to: string, state?: object) => void;
  blocked?: string;
}) {
  const { t } = useTranslation();
  const target = requestPath(job);
  const what = t(messageKey);
  const where = jobWhere(job);
  return (
    <li className="px-jobs-problem">
      <Search className="px-jobs-problem-mark is-request" size={20} strokeWidth={1.75} aria-hidden />
      <p className="px-jobs-what">{what}</p>
      {where ? <p className="px-jobs-why">{where}</p> : null}
      <div className="px-jobs-acts">
        {target ? (
          <Button size="sm" variant="secondary" disabled={Boolean(blocked)} title={blocked} onClick={() => onNavigate(target.to, target.state)}>
            {t("jobs.changeRequest")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("jobs.actionOn", { action: t("jobs.dismiss"), name: where ? `${what}, ${where}` : what })}
          onClick={() => act("jobs.dismiss", [job])}
        >
          {t("jobs.dismiss")}
        </Button>
      </div>
    </li>
  );
}

/** When a tool's requests are back, as the row says it: what the Wait button offers and what the row under it tells. */
function useWhen() {
  const { t, i18n } = useTranslation();
  return (until: number) => {
    const when = limitWhen(until, Date.now());
    const time = new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(until);
    const day = new Intl.DateTimeFormat(i18n.language, { weekday: "long", day: "numeric", month: "long" }).format(until);
    return {
      when,
      time,
      day,
      /** "Tornano domani alle 06:00." */
      text: t(`jobs.out.back.${when}`, { time, day }),
      /** "domani alle 06:00", to follow a verb. */
      at: t(`jobs.out.at.${when}`, { time, day }),
    };
  };
}

/**
 * A tool ran out of requests while a job needed it. The student chooses: go on with the next tool of their list, wait
 * until the requests are back, or (with no other tool to go on with) open the tools in Settings. A job that ran out on
 * the same tool as another one shares its row, since the choice is the same for both.
 */
function OutOfRequestsCard({
  problem,
  tools,
  settle,
  act,
  onNavigate,
  blocked,
}: {
  problem: Problem;
  tools: ToolLimits;
  settle: (sent: Promise<unknown>) => void;
  act: Act;
  onNavigate: (to: string, state?: object) => void;
  blocked?: string;
}) {
  const { t } = useTranslation();
  const nameOf = useJobName();
  const whenOf = useWhen();
  const [busy, setBusy] = useState(false);
  const { jobs, engine } = problem;
  const first = jobs[0]!;
  const many = jobs.length > 1;
  const tool = tools.rows.find((row) => row.id === engine);
  const name = tool?.name ?? engine ?? "";
  const until = engine ? tools.limits.get(engine) : undefined;
  const next = tools.next(engine);
  const when = until === undefined ? undefined : whenOf(until);
  const named = (action: string) => (many ? undefined : t("jobs.actionOn", { action, name: nameOf(first) }));
  // Each choice starts every job of the row, and the row goes when they leave the list.
  const send = (run: (job: JobView) => Promise<unknown>) => {
    setBusy(true);
    settle(Promise.all(jobs.map(run)).finally(() => setBusy(false)));
  };
  return (
    <li className="px-jobs-problem px-jobs-out">
      <CircleAlert className="px-jobs-problem-mark" size={20} strokeWidth={1.75} aria-hidden />
      <p className="px-jobs-what">{many ? t("jobs.problem.many.failed", { count: jobs.length }) : nameOf(first)}</p>
      <p className="px-jobs-why">
        {[t("jobs.out.why", { tool: name }), when?.text].filter(Boolean).join(" ")}
      </p>
      <div className="px-jobs-acts">
        {next ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            aria-label={named(t("jobs.out.goOn", { tool: next.name }))}
            onClick={() => send((job) => invoke("jobs.retryWith", { jobId: job.id, provider: next.id as InstallableProvider }))}
          >
            {t("jobs.out.goOn", { tool: next.name })}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={Boolean(blocked)}
            title={blocked}
            onClick={() => onNavigate("/settings/engines")}
          >
            {t("settings.enginesTitle")}
          </Button>
        )}
        {when ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={named(t(`jobs.out.wait.${when.when}`, { time: when.time, day: when.day }))}
            onClick={() => send((job) => invoke("jobs.wait", { jobId: job.id, wait: true }))}
          >
            {t(`jobs.out.wait.${when.when}`, { time: when.time, day: when.day })}
          </Button>
        ) : null}
      </div>
      {/* The way to let the job go, at the row's right on the title's line, as a finished row's is; last in the focus order. */}
      <span className="px-jobs-out-x">
        <IconButton
          icon="x"
          size="sm"
          variant="ghost"
          disabled={busy}
          label={t("jobs.actionOn", {
            action: t("jobs.dismiss"),
            name: many ? t("jobs.problem.many.failed", { count: jobs.length }) : nameOf(first),
          })}
          onClick={() => act("jobs.dismiss", jobs)}
        />
      </span>
    </li>
  );
}

/** A job the student has wait for a tool's requests: it starts again by itself, and Ferma gives the wait up. */
function WaitingRow({
  job,
  tools,
  settle,
}: {
  job: JobView;
  tools: ToolLimits;
  settle: (sent: Promise<unknown>) => void;
}) {
  const { t } = useTranslation();
  const nameOf = useJobName();
  const whenOf = useWhen();
  const until = job.waitingUntil!;
  const engine = jobErrorEngine(job.error ?? "");
  const tool = tools.rows.find((row) => row.id === engine)?.name ?? engine ?? "";
  return (
    <li className="px-jobs-row px-jobs-waiting">
      <Icon name="clock" size={20} className="px-jobs-mark" />
      <div className="px-jobs-body">
        <p className="px-jobs-what">{nameOf(job)}</p>
        <p className="px-jobs-sub">{t("jobs.out.waiting", { tool, when: whenOf(until).at })}</p>
      </div>
      <IconButton
        icon="square"
        size="sm"
        variant="ghost"
        label={t("jobs.actionOn", { action: t("jobs.out.stopWaiting"), name: nameOf(job) })}
        onClick={() => settle(invoke("jobs.wait", { jobId: job.id, wait: false }))}
      />
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
      <RunningMark running={job.state === "running"} />
      <div className="px-jobs-body">
        <p className="px-jobs-what">{what}</p>
        {where || job.state === "queued" ? (
          <p className="px-jobs-sub">
            {[job.state === "queued" ? t("jobs.state.queued") : "", where].filter(Boolean).join(" · ")}
          </p>
        ) : null}
        <Bar value={job.progress} label={where ? `${what}, ${where}` : what} />
        <JobDebug jobId={job.id} running={job.state === "running"} />
      </div>
      {/* Work a page does itself stops on that page. */}
      {job.inPage ? null : (
        <IconButton
          icon="square"
          size="sm"
          variant="ghost"
          label={t("jobs.actionOn", { action: t("jobs.stop"), name: nameOf(job) })}
          onClick={() => act("jobs.cancel", [job])}
        />
      )}
    </li>
  );
}

/**
 * The jobs one request made, such as the files of a linked folder, as one row: what they do and how many are done, the
 * folder they come from and a bar. It opens in place on the first few by name, each with its state, then a count of
 * the rest. Running, it stops them all; finished, it clears them all.
 */
function BatchRow({ batch, act, finished = false }: { batch: JobBatch; act: Act; finished?: boolean }) {
  const { t, i18n } = useTranslation();
  const doing = useJobDoing();
  const nameOf = useJobName();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const words = BATCH_WORDS[batch.family] ?? "other";
  const done = batch.done.length;
  const total = done + batch.jobs.length + batch.waiting;
  const first = batch.jobs[0] ?? batch.done[0]!;
  const what = finished
    ? t(`jobs.batch.finished.${words}`, { count: done, what: t(finishedLabelKey(first.kind) ?? "jobs.state.succeeded") })
    : t(`jobs.batch.running.${words}`, { done, total, what: doing(first) });
  const where = batch.folder ? t("jobs.batch.fromFolder", { folder: batch.folder }) : undefined;
  const running = batch.jobs.some((job) => job.state === "running");
  const progress = total
    ? (done + batch.jobs.reduce((sum, job) => sum + job.progress, 0)) / total
    : 0;
  // Running work first, then what waits, as it will be read; a finished request lists what it read.
  const members = finished
    ? batch.done
    : [...batch.jobs.filter((job) => job.state === "running"), ...batch.jobs.filter((job) => job.state !== "running")];
  const named = members.slice(0, BATCH_NAMED);
  const rest = members.length - named.length + (finished ? 0 : batch.waiting);
  const restLine = [
    rest > 0 ? t(finished ? "jobs.batch.more" : "jobs.batch.moreWaiting", { count: rest }) : "",
    !finished && done > 0 ? t(`jobs.batch.done.${words}`, { count: done }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const latest = finished ? new Date(batch.done.reduce((at, job) => Math.max(at, job.updatedAt), 0)) : undefined;
  // Another engine answered for some of them: the row says so once, as a single job's row does.
  const fallback = [...batch.jobs, ...batch.done].find((job) => job.fallback)?.fallback;
  return (
    <li className={open ? "px-jobs-batch is-open" : "px-jobs-batch"}>
      <div className="px-jobs-batch-head">
        <button
          type="button"
          className="px-jobs-batch-main"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
        >
          {finished ? (
            <Icon name="circle-check" size={20} className="px-jobs-mark is-done" />
          ) : (
            <RunningMark running={running} />
          )}
          <span className="px-jobs-body">
            <span className="px-jobs-what">{what}</span>
            {where ? <span className="px-jobs-sub">{where}</span> : null}
            {finished ? null : <Bar value={progress} label={where ? `${what}, ${where}` : what} />}
          </span>
          {latest ? (
            <time className="px-jobs-when" dateTime={latest.toISOString()}>
              {new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(latest)}
            </time>
          ) : null}
          <span className="px-chevron px-jobs-caret" aria-hidden />
        </button>
        {finished ? (
          <IconButton
            icon="x"
            size="sm"
            variant="ghost"
            label={t("jobs.actionOn", { action: t("jobs.dismiss"), name: where ? `${what}, ${where}` : what })}
            onClick={() => act("jobs.dismiss", batch.done)}
          />
        ) : batch.jobs.every((job) => job.inPage) ? null : (
          <IconButton
            icon="square"
            size="sm"
            variant="ghost"
            label={t("jobs.actionOn", { action: t("jobs.stop"), name: what })}
            onClick={() => act("jobs.cancel", batch.jobs.filter((job) => !job.inPage))}
          />
        )}
      </div>
      {fallback ? (
        <p className="px-jobs-note px-jobs-batch-note">
          <Info size={16} strokeWidth={1.75} aria-hidden />
          <span>{t(`engines.fallback.${fallback.reason}`, { from: currentToolLabel(fallback.from), to: currentToolLabel(fallback.to) })}</span>
        </p>
      ) : null}
      <div className="px-jobs-more" id={listId} inert={!open}>
        <ul>
          {named.map((job) => (
            <li key={job.id}>
              <span className="px-jobs-item">{nameOf(job)}</span>
              {finished ? null : (
                <span className="px-jobs-item-state">
                  {job.state === "running" ? <Logo size={15} working decorative /> : null}
                  {t(job.state === "running" ? `jobs.batch.item.${words}` : "jobs.batch.item.waiting")}
                </span>
              )}
            </li>
          ))}
          {restLine ? <li className="px-jobs-rest">{restLine}</li> : null}
        </ul>
      </div>
    </li>
  );
}

/** A finished job: what it made. */
function FinishedRow({ job, act }: { job: JobView; act: Act }) {
  const { t, i18n } = useTranslation();
  const topicOf = useJobTopic();
  const what = t(finishedLabelKey(job.kind) ?? "jobs.state.succeeded", {
    context: jobContext(job),
    topic: topicOf(job),
  });
  const where = jobWhere(job);
  const at = new Date(job.updatedAt);
  const time = new Intl.DateTimeFormat(i18n.language, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
  return (
    <li className="px-jobs-row">
      {/* Work another tool finished has the arrows of a change, so the line under it needs no box. */}
      <Icon name={job.fallback ? "refresh-cw" : "circle-check"} size={20} className="px-jobs-mark is-done" />
      <div className="px-jobs-body">
        <p className="px-jobs-what">{what}</p>
        {where ? <p className="px-jobs-sub">{where}</p> : null}
        {job.fallback ? (
          <p className="px-jobs-sub">
            {t(`engines.fallback.${job.fallback.reason}`, {
              from: currentToolLabel(job.fallback.from),
              to: currentToolLabel(job.fallback.to),
            })}
          </p>
        ) : null}
        <JobDebug jobId={job.id} running={false} />
      </div>
      <time className="px-jobs-when" dateTime={at.toISOString()}>
        {time}
      </time>
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
    /** The tools that are out of requests and the ones a stopped job can go on with. */
    tools: ToolLimits;
    /** Asks for the password of a locked PDF whose import stopped. */
    onUnlock: (job: JobView) => void;
    /** Closes the list, after it sent the student to another page. */
    onClose: () => void;
    onEscape: () => void;
    /** A page's own rule for being left: a link that goes to another page waits for it. */
    leave?: (then: () => void) => void;
    /** Why the page cannot be left, when nothing leaves it: those links are off. */
    blocked?: string;
  }
>(function JobsPanel({ groups, tools, onUnlock, onClose, onEscape, leave, blocked }, ref) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const client = useQueryClient();
  const navigate = useNavigate();
  const headId = useId();
  // A job that changed meanwhile, or a core that restarted, refuses the action. Say so and show the list as it is now.
  const settle = (sent: Promise<unknown>) => {
    void sent.catch(() => {
      void message.error(t("jobs.actionFailed"));
      void client.invalidateQueries({ queryKey: ["jobs"] });
      void client.invalidateQueries({ queryKey: ["jobs-finished"] });
    });
  };
  const act: Act = (request, jobs) =>
    settle(
      request === "jobs.resumeAll"
        ? invoke(request, { jobIds: jobs.map((job) => job.id) })
        : Promise.all(jobs.map((job) => invoke(request, { jobId: job.id }))),
    );
  const { problems, runningItems, finishedItems, finished, running, waiting } = groups;
  const stoppable = running.some((job) => !job.inPage);
  // Stopping everything asks nothing: what stopped waits under "Needs you" with Resume.
  const stopAll = () => {
    void invoke("jobs.stopAll", {}).catch(() => {
      void message.error(t("jobs.actionFailed"));
      void client.invalidateQueries({ queryKey: ["jobs"] });
    });
  };
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
        <div className="px-jobs-title">
          <h2 id={headId}>{t("jobs.title")}</h2>
          <p>{t("jobs.intro")}</p>
        </div>
      </header>
      {problems.length > 0 ? (
        <GroupSection title={t("jobs.group.toFix")} needs>
          {problems.map((problem) => {
            const onNavigate = (to: string, state?: object) => {
              onClose();
              const go = () => void navigate(to, state ? { state } : undefined);
              if (leave) leave(go);
              else go();
            };
            return problem.kind === "out-of-requests" ? (
              <OutOfRequestsCard
                key={problem.key}
                problem={problem}
                tools={tools}
                settle={settle}
                act={act}
                blocked={blocked}
                onNavigate={onNavigate}
              />
            ) : (
              <ProblemCard
                key={problem.key}
                problem={problem}
                act={act}
                onUnlock={onUnlock}
                blocked={blocked}
                onNavigate={onNavigate}
              />
            );
          })}
        </GroupSection>
      ) : null}
      {runningItems.length + waiting.length > 0 ? (
        <GroupSection
          title={t("jobs.group.running")}
          action={
            stoppable ? (
              <Button size="sm" variant="ghost" onClick={stopAll}>
                {t("jobs.stopAll")}
              </Button>
            ) : null
          }
        >
          {runningItems.map((item) =>
            item.batch ? (
              <BatchRow key={item.batch.key} batch={item.batch} act={act} />
            ) : (
              <RunningRow key={item.job.id} job={item.job} act={act} />
            ),
          )}
          {waiting.map((job) => (
            <WaitingRow key={job.id} job={job} tools={tools} settle={settle} />
          ))}
        </GroupSection>
      ) : null}
      {finished.length > 0 ? (
        <GroupSection
          title={t("jobs.group.done")}
          action={
            <Button size="sm" variant="ghost" onClick={() => act("jobs.dismiss", finished)}>
              {t("jobs.clearDone")}
            </Button>
          }
        >
          {finishedItems.map((item) =>
            item.batch ? (
              <BatchRow key={item.batch.key} batch={item.batch} act={act} finished />
            ) : (
              <FinishedRow key={item.job.id} job={item.job} act={act} />
            ),
          )}
        </GroupSection>
      ) : null}
    </section>
  );
});

function GroupSection({
  title,
  needs = false,
  action,
  children,
}: {
  title: string;
  /** What waits for the student, titled in full ink. */
  needs?: boolean;
  /** One button that acts on the whole group, beside its title. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={needs ? "px-jobs-group is-needs" : "px-jobs-group"} aria-labelledby={id}>
      <div className="px-jobs-group-head">
        <h3 className="label" id={id}>
          {title}
        </h3>
        {action}
      </div>
      <ul className="px-jobs-list">{children}</ul>
    </section>
  );
}
