import { setTimeout as wait } from "node:timers/promises";
import { availableParallelism } from "node:os";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { IpcError, isAbort, type JobView } from "../../shared/ipc";
import { withUsageScope } from "../engine/usage";

export type JobClass = "model-cli" | "model-api" | "local" | "demo";

export type StepContext = {
  name: string;
  signal: AbortSignal;
  params: unknown;
  setParams: (params: unknown) => void;
  /** How far this step is, from 0 to 1. The job's progress moves within the step's share; one long step can show it. */
  progress: (fraction: number) => void;
};

export type StepSpec = {
  /** null releases all execution slots while awaiting another job. */
  jobClass?: JobClass | null;
  name: string;
  label: string;
  run: (ctx: StepContext) => Promise<unknown>;
  /** New jobs leave the step out; a job saved before an update still runs it. */
  retired?: boolean;
};

export type JobSpec = {
  jobClass: JobClass;
  steps: StepSpec[];
  /** Refresh settings only on an explicit retry; interruption resume keeps its snapshot. */
  retryParams?: (params: unknown) => unknown;
  /** What the job works on, such as a file's name, for the jobs list. */
  title?: (params: unknown) => string | null;
  /** The exam and topic study work is about, for the jobs list. */
  about?: (params: unknown) => JobAbout;
  /** What a page waiting on the job knows it by (`JobView.ref`). */
  ref?: (params: unknown) => string | null;
  /**
   * A student is waiting on screen for this job, such as an answer being corrected. It takes a model slot of its own
   * class next to background work (writing a quiz, analysing mistakes) instead of queueing behind it; interactive jobs
   * still share the class's limit among themselves.
   */
  interactive?: boolean;
  /**
   * Runs when a job of this kind ends without finishing, however it got there: cancelled while a step ran, while it
   * waited for a slot or before it started, or dismissed while interrupted. A step's own cleanup only covers the first.
   */
  onCancelled?: (params: unknown) => void;
};

export type Limits = Record<JobClass, number>;

export type JobAbout = Pick<JobView, "topic" | "exam" | "activity">;

/** Work a request does itself, as the runner lists it while it lasts. */
export type Tracked = {
  progress: (fraction: number) => void;
  /** Ends the entry; one that succeeded is kept as a finished job. Later calls do nothing. */
  finish: (succeeded: boolean) => void;
};

type JobRow = {
  id: string;
  kind: string;
  state: JobView["state"];
  progress: number;
  step_label: string | null;
  error: string | null;
  params_json: string;
};

type ViewRow = Omit<JobRow, "params_json"> & {
  updated_at: number;
  fallback_json: string | null;
};

type StepRow = {
  id: string;
  job_id: string;
  name: string;
  position: number;
  label: string;
  state: "pending" | "running" | "succeeded" | "failed";
  output_json: string | null;
  error: string | null;
};

/**
 * The kind of tracked work (see `Runner.track`). Its finished rows store what the work was about as their params;
 * register its kinds at startup so those rows read the same after a restart.
 */
export const trackedJob: JobSpec = { jobClass: "local", steps: [], about: (params) => params as JobAbout };

const defaultLimits = (): Limits => ({
  "model-cli": 2,
  "model-api": 4,
  local: Math.max(1, availableParallelism() - 1),
  demo: 1,
});

export type Runner = {
  activate: () => void;
  register: (kind: string, spec: JobSpec) => void;
  start: (kind: string, params?: unknown) => string;
  cancel: (jobId: string) => void;
  retry: (jobId: string) => void;
  resume: (jobId: string) => void;
  resumeLocal: (kinds: string[]) => string[];
  dismiss: (jobId: string) => void;
  list: () => JobView[];
  /** Jobs that succeeded today and were not cleared, newest first. The day bounds the list, so it has no other limit: clearing it must reach every job. */
  finished: (now?: number) => JobView[];
  /** Notes that another engine answered a call of this job, for the job's list entry. The latest one is kept. */
  noteFallback: (
    jobId: string,
    fallback: NonNullable<JobView["fallback"]>,
  ) => void;
  /**
   * Lists model work a request does itself rather than as a queued job, such as a lesson streaming to its page: as
   * running while it lasts, with `label` as its step, and as a finished job of `kind` once it succeeds. It takes no
   * slot and the list offers no cancel; its page stops it.
   */
  track: (kind: string, about: JobAbout, label: string) => Tracked;
};

export function createRunner(
  db: Database.Database,
  onUpdate: (job: JobView) => void,
  limits: Limits = defaultLimits(),
  paused = false,
): Runner {
  let enabled = !paused;
  const specs = new Map<string, JobSpec>();
  const active = new Map<
    string,
    { controller: AbortController; jobClass: JobClass | null; interactive: boolean }
  >();

  const jobStmt = db.prepare(
    `SELECT id, kind, state, progress, step_label, error, params_json FROM jobs WHERE id = ?`,
  );
  const stepsStmt = db.prepare(
    `SELECT id, job_id, name, position, label, state, output_json, error
     FROM job_steps WHERE job_id = ? ORDER BY position`,
  );
  // A view is built at every step start and end. Params and step outputs can hold whole topic trees, and the view
  // shows neither, so it reads params only for a title and never reads outputs.
  const jobViewStmt = db.prepare(
    `SELECT id, kind, state, progress, step_label, error, updated_at, fallback_json FROM jobs WHERE id = ?`,
  );
  const paramsStmt = db.prepare(`SELECT params_json FROM jobs WHERE id = ?`);
  const stepViewsStmt = db.prepare(
    `SELECT name, label, state FROM job_steps WHERE job_id = ? ORDER BY position`,
  );

  /** Work tracked for requests, while it runs. Finished work is a job row like any other. */
  const tracked = new Map<string, JobView>();

  function viewOf(jobId: string): JobView | null {
    const job = jobViewStmt.get(jobId) as ViewRow | undefined;
    if (!job) return null;
    const steps = stepViewsStmt.all(jobId) as JobView["steps"];
    const spec = specs.get(job.kind);
    const params =
      spec?.title || spec?.about || spec?.ref
        ? (JSON.parse((paramsStmt.get(jobId) as { params_json: string }).params_json) as unknown)
        : undefined;
    const title = spec?.title?.(params);
    const about = spec?.about?.(params) ?? {};
    const ref = spec?.ref?.(params);
    return {
      id: job.id,
      kind: job.kind,
      ...(title ? { title } : {}),
      ...(about.topic ? { topic: about.topic } : {}),
      ...(about.exam ? { exam: about.exam } : {}),
      ...(about.activity ? { activity: about.activity } : {}),
      ...(ref ? { ref } : {}),
      state: job.state,
      progress: job.progress,
      stepLabel: job.step_label,
      error: job.error,
      steps,
      updatedAt: job.updated_at,
      ...(job.fallback_json
        ? { fallback: JSON.parse(job.fallback_json) as JobView["fallback"] }
        : {}),
    };
  }

  /**
   * A step still running when core closes the database (shutdown, a workspace swap, a test that ends) settles later.
   * It then writes, publishes and starts nothing: the job stays running in the closed file, and the next start marks
   * it interrupted like any other job a quit stopped.
   */
  const closed = () => !db.open;

  function publish(jobId: string): void {
    if (closed()) return;
    const view = viewOf(jobId);
    if (view) onUpdate(view);
  }

  /**
   * Whether a job may not take a slot of `jobClass` now. Background work shares the class's slots with everything
   * running; an interactive job counts only the interactive ones, so it never waits behind a long background call.
   */
  function full(jobClass: JobClass, interactive: boolean): boolean {
    let used = 0;
    for (const entry of active.values()) {
      if (entry.jobClass === jobClass && (!interactive || entry.interactive)) used += 1;
    }
    return used >= limits[jobClass];
  }

  function setParams(jobId: string, params: unknown): void {
    db.prepare(
      `UPDATE jobs SET params_json = ?, updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(params ?? {}), Date.now(), jobId);
  }

  function readParams(jobId: string): unknown {
    const job = jobStmt.get(jobId) as JobRow | undefined;
    if (!job) return {};
    return JSON.parse(job.params_json) as unknown;
  }

  async function execute(jobId: string): Promise<void> {
    // Scheduled before the database closed: nothing to run, and nothing to read it from.
    if (closed()) {
      active.delete(jobId);
      return;
    }
    const entry = active.get(jobId);
    const job = jobStmt.get(jobId) as JobRow | undefined;
    const spec = job ? specs.get(job.kind) : undefined;
    if (!entry || !job || !spec) {
      active.delete(jobId);
      queueMicrotask(kick);
      return;
    }
    const now = Date.now();
    db.prepare(
      `UPDATE jobs SET state = 'running', error = NULL, updated_at = ? WHERE id = ?`,
    ).run(now, jobId);
    publish(jobId);
    try {
      const steps = stepsStmt.all(jobId) as StepRow[];
      for (const step of steps) {
        if (step.output_json != null) continue;
        if (entry.controller.signal.aborted) {
          finishCancelled(jobId);
          return;
        }
        db.prepare(
          `UPDATE job_steps SET state = 'running', error = NULL WHERE id = ?`,
        ).run(step.id);
        const done = steps.filter((item) => item.output_json != null).length;
        db.prepare(
          `UPDATE jobs SET step_label = ?, progress = ?, updated_at = ? WHERE id = ?`,
        ).run(step.label, done / steps.length, Date.now(), jobId);
        publish(jobId);
        const specStep = spec.steps.find((item) => item.name === step.name);
        try {
          // A step an app update renamed or removed fails its job rather than leaving it running.
          if (!specStep) throw new Error(`missing-step:${step.name}`);
          const desired =
            specStep.jobClass === undefined ? spec.jobClass : specStep.jobClass;
          if (entry.jobClass !== desired) {
            entry.jobClass = null;
            queueMicrotask(kick);
          }
          while (
            desired !== null &&
            entry.jobClass !== desired &&
            full(desired, entry.interactive)
          ) {
            await wait(25, undefined, { signal: entry.controller.signal });
            // A slot may never free up once the database is closed; stop asking.
            if (closed()) return;
          }
          entry.jobClass = desired;
          queueMicrotask(kick);
          const output = await withUsageScope({ jobId, kind: job.kind }, () =>
            specStep.run({
              name: step.name,
              signal: entry.controller.signal,
              params: readParams(jobId),
              setParams: (params) => setParams(jobId, params),
              progress: (fraction) => {
                const share = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
                db.prepare(`UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?`).run(
                  (done + share) / steps.length,
                  Date.now(),
                  jobId,
                );
                publish(jobId);
              },
            }),
          );
          if (closed()) return;
          if (entry.controller.signal.aborted) {
            db.prepare(
              `UPDATE job_steps SET state = 'pending' WHERE id = ?`,
            ).run(step.id);
            finishCancelled(jobId);
            return;
          }
          db.prepare(
            `UPDATE job_steps SET state = 'succeeded', output_json = ?, error = NULL WHERE id = ?`,
          ).run(JSON.stringify(output ?? null), step.id);
          step.output_json = JSON.stringify(output ?? null);
          entry.jobClass = null;
          queueMicrotask(kick);
        } catch (err) {
          if (closed()) return;
          if (entry.controller.signal.aborted || isAbort(err)) {
            db.prepare(
              `UPDATE job_steps SET state = 'pending' WHERE id = ?`,
            ).run(step.id);
            finishCancelled(jobId);
            return;
          }
          // An engine failure keeps its code first, so the screen can name it, and the engine's own text after it.
          const message =
            err instanceof IpcError &&
            err.detail &&
            err.messageKey.startsWith("engines.errors.")
              ? `${err.code}: ${err.detail}`
              : err instanceof Error
                ? err.message
                : "failed";
          db.prepare(
            `UPDATE job_steps SET state = 'failed', error = ? WHERE id = ?`,
          ).run(message, step.id);
          db.prepare(
            `UPDATE jobs SET state = 'failed', error = ?, updated_at = ? WHERE id = ?`,
          ).run(message, Date.now(), jobId);
          return;
        }
      }
      db.prepare(
        `UPDATE jobs SET state = 'succeeded', progress = 1, step_label = NULL, error = NULL, updated_at = ? WHERE id = ?`,
      ).run(Date.now(), jobId);
    } finally {
      active.delete(jobId);
      publish(jobId);
      kick();
    }
  }

  function resume(jobId: string): void {
    const changed = db
      .prepare(
        `UPDATE jobs SET state = 'queued', dismissed = 0, updated_at = ? WHERE id = ? AND state = 'interrupted'`,
      )
      .run(Date.now(), jobId);
    if (changed.changes === 0) return;
    publish(jobId);
    kick();
  }

  function finishCancelled(jobId: string): void {
    db.prepare(
      `UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE id = ?`,
    ).run(Date.now(), jobId);
    cancelled(jobId);
  }

  function cancelled(jobId: string): void {
    abandoned(jobStmt.get(jobId) as JobRow | undefined);
  }

  function abandoned(job: JobRow | undefined): void {
    const hook = job ? specs.get(job.kind)?.onCancelled : undefined;
    if (job && hook) hook(JSON.parse(job.params_json) as unknown);
  }

  function kick(): void {
    if (!enabled || closed()) return;
    const queued = db
      .prepare(
        `SELECT id, kind FROM jobs WHERE state = 'queued' ORDER BY created_at, rowid`,
      )
      .all() as Array<{ id: string; kind: string }>;
    for (const job of queued) {
      const spec = specs.get(job.kind);
      if (!spec || active.has(job.id)) continue;
      const interactive = spec.interactive === true;
      if (full(spec.jobClass, interactive)) continue;
      active.set(job.id, {
        controller: new AbortController(),
        jobClass: spec.jobClass,
        interactive,
      });
      queueMicrotask(() => void execute(job.id));
    }
  }

  db.prepare(
    `UPDATE job_steps SET state = 'pending' WHERE state = 'running'`,
  ).run();
  db.prepare(
    `UPDATE jobs SET state = 'interrupted', updated_at = ? WHERE state = 'running'`,
  ).run(Date.now());

  return {
    activate() {
      enabled = true;
      kick();
    },
    register(kind, spec) {
      specs.set(kind, spec);
      kick();
    },
    start(kind, params) {
      const spec = specs.get(kind);
      if (!spec) throw new Error(`unknown-job:${kind}`);
      const jobId = uuidv7();
      const now = Date.now();
      const insert = db.transaction(() => {
        db.prepare(
          `INSERT INTO jobs (id, kind, params_json, state, progress, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', 0, ?, ?)`,
        ).run(jobId, kind, JSON.stringify(params ?? {}), now, now);
        const stepInsert = db.prepare(
          `INSERT INTO job_steps (id, job_id, name, position, label, state)
           VALUES (?, ?, ?, ?, ?, 'pending')`,
        );
        spec.steps
          .filter((step) => !step.retired)
          .forEach((step, index) => {
            stepInsert.run(uuidv7(), jobId, step.name, index, step.label);
          });
      });
      insert();
      queueMicrotask(() => {
        publish(jobId);
        kick();
      });
      return jobId;
    },
    cancel(jobId) {
      const entry = active.get(jobId);
      if (entry) {
        entry.controller.abort();
        return;
      }
      const changed = db
        .prepare(
          `UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE id = ? AND state IN ('queued', 'interrupted')`,
        )
        .run(Date.now(), jobId);
      if (changed.changes > 0) {
        cancelled(jobId);
        publish(jobId);
      }
    },
    retry(jobId) {
      const job = db
        .prepare(
          "SELECT kind, params_json FROM jobs WHERE id = ? AND state IN ('failed', 'cancelled')",
        )
        .get(jobId) as { kind: string; params_json: string } | undefined;
      if (!job) return;
      const refresh = specs.get(job.kind)?.retryParams;
      if (refresh) {
        try {
          const params = refresh(JSON.parse(job.params_json));
          db.prepare("UPDATE jobs SET params_json = ? WHERE id = ?").run(
            JSON.stringify(params),
            jobId,
          );
        } catch (error) {
          db.prepare("UPDATE jobs SET error = ? WHERE id = ?").run(
            error instanceof Error ? error.message : "failed",
            jobId,
          );
          publish(jobId);
          return;
        }
      }
      const changed = db
        .prepare(
          `UPDATE jobs SET state = 'queued', dismissed = 0, error = NULL, fallback_json = NULL, updated_at = ? WHERE id = ? AND state IN ('failed', 'cancelled')`,
        )
        .run(Date.now(), jobId);
      if (changed.changes === 0) return;
      db.prepare(
        `UPDATE job_steps SET state = 'pending', error = NULL
         WHERE job_id = ? AND output_json IS NULL`,
      ).run(jobId);
      publish(jobId);
      kick();
    },
    resume,
    /**
     * Resumes the interrupted jobs of `kinds` whose next step does local work, and returns their ids. A model step
     * keeps waiting for the student's Resume, since it uses an engine. A job resumes this way once per step: one that
     * stops again at the step it was resumed at (it may be what ended the process) waits for the student too. The step
     * is noted in the job's input as `autoResumedAt`. Call it after the kinds are registered.
     */
    resumeLocal(kinds) {
      const rows = db
        .prepare(
          `SELECT id, kind, params_json FROM jobs WHERE state = 'interrupted' AND kind IN (${kinds.map(() => "?").join(", ")})
           ORDER BY created_at, rowid`,
        )
        .all(...kinds) as Array<{ id: string; kind: string; params_json: string }>;
      const resumed: string[] = [];
      for (const row of rows) {
        const spec = specs.get(row.kind);
        const next = (stepsStmt.all(row.id) as StepRow[]).find((step) => step.output_json == null);
        const specStep = next ? spec?.steps.find((step) => step.name === next.name) : undefined;
        if (!spec || !next || !specStep) continue;
        const stepClass = specStep.jobClass === undefined ? spec.jobClass : specStep.jobClass;
        const params = JSON.parse(row.params_json) as { autoResumedAt?: string } | null;
        if (stepClass !== "local" || params?.autoResumedAt === next.name) continue;
        setParams(row.id, { ...(params ?? {}), autoResumedAt: next.name });
        resume(row.id);
        resumed.push(row.id);
      }
      return resumed;
    },
    dismiss(jobId) {
      if (active.has(jobId)) return;
      const view = viewOf(jobId);
      if (
        (view?.kind === "cards-build" ||
          view?.kind === "gap-drill" ||
          view?.kind === "exercise-build" ||
          view?.kind === "plan-build" ||
          view?.kind === "quiz-build" ||
          view?.kind === "quiz-grade" ||
          view?.kind === "simulation-build" ||
          view?.kind === "map-build" ||
          view?.kind === "simulation-grade" ||
          // A finished analysis's row is what stops the same attempt and topic being analysed again.
          (view?.kind === "gap-insight" && view.state === "succeeded")) &&
        ["failed", "cancelled", "succeeded", "interrupted"].includes(view.state)
      ) {
        db.prepare("UPDATE jobs SET dismissed = 1 WHERE id = ?").run(jobId);
        publish(jobId);
        return;
      }
      // An interrupted job was still going to finish; dismissing it gives it up, as a cancel does.
      const unfinished = view?.state === "interrupted" ? (jobStmt.get(jobId) as JobRow | undefined) : undefined;
      const changed = db
        .prepare(
          `DELETE FROM jobs WHERE id = ? AND state IN ('failed', 'cancelled', 'succeeded', 'interrupted')`,
        )
        .run(jobId);
      if (changed.changes > 0 && view) {
        abandoned(unfinished);
        onUpdate({ ...view, state: "cancelled" });
      }
    },
    noteFallback(jobId, fallback) {
      const changed = db
        .prepare(`UPDATE jobs SET fallback_json = ? WHERE id = ?`)
        .run(JSON.stringify(fallback), jobId);
      if (changed.changes > 0) publish(jobId);
    },
    finished(now = Date.now()) {
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      const rows = db
        .prepare(
          `SELECT id FROM jobs
           WHERE dismissed = 0 AND state = 'succeeded' AND updated_at >= ?
           ORDER BY updated_at DESC, rowid DESC`,
        )
        .all(midnight.getTime()) as Array<{ id: string }>;
      return rows.flatMap((row) => {
        const view = viewOf(row.id);
        return view ? [view] : [];
      });
    },
    list() {
      const rows = db
        .prepare(
          `SELECT id FROM jobs
           WHERE dismissed = 0 AND state IN ('queued', 'running', 'failed', 'cancelled', 'interrupted')
           ORDER BY created_at`,
        )
        .all() as Array<{ id: string }>;
      return [
        ...rows.flatMap((row) => {
          const view = viewOf(row.id);
          return view ? [view] : [];
        }),
        ...[...tracked.values()].map((view) => ({ ...view })),
      ];
    },
    track(kind, about, label) {
      if (!specs.has(kind)) specs.set(kind, trackedJob);
      const id = uuidv7();
      const startedAt = Date.now();
      // Only what is set: the view goes over IPC, where an absent field and an undefined one differ.
      const known: JobAbout = {
        ...(about.topic ? { topic: about.topic } : {}),
        ...(about.exam ? { exam: about.exam } : {}),
        ...(about.activity ? { activity: about.activity } : {}),
      };
      const view: JobView = {
        id,
        kind,
        ...known,
        inPage: true,
        state: "running",
        progress: 0,
        stepLabel: label,
        error: null,
        steps: [],
        updatedAt: startedAt,
      };
      tracked.set(id, view);
      onUpdate({ ...view });
      return {
        progress(fraction) {
          const value = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
          if (!tracked.has(id) || value === view.progress) return;
          view.progress = value;
          view.updatedAt = Date.now();
          onUpdate({ ...view });
        },
        finish(succeeded) {
          if (!tracked.delete(id) || closed()) return;
          if (!succeeded) {
            onUpdate({ ...view, state: "cancelled" });
            return;
          }
          db.prepare(
            `INSERT INTO jobs (id, kind, params_json, state, progress, created_at, updated_at)
             VALUES (?, ?, ?, 'succeeded', 1, ?, ?)`,
          ).run(id, kind, JSON.stringify(known), startedAt, Date.now());
          publish(id);
        },
      };
    },
  };
}

export function sleep(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
