import { availableParallelism } from "node:os";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { isAbort, type JobView } from "../../shared/ipc";

export type JobClass = "model-cli" | "model-api" | "local" | "demo";

export type StepContext = {
  name: string;
  signal: AbortSignal;
  params: unknown;
  setParams: (params: unknown) => void;
};

export type StepSpec = {
  name: string;
  label: string;
  run: (ctx: StepContext) => Promise<unknown>;
};

export type JobSpec = {
  jobClass: JobClass;
  steps: StepSpec[];
};

export type Limits = Record<JobClass, number>;

type JobRow = {
  id: string;
  kind: string;
  state: JobView["state"];
  progress: number;
  step_label: string | null;
  error: string | null;
  params_json: string;
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

const defaultLimits = (): Limits => ({
  "model-cli": 2,
  "model-api": 4,
  local: Math.max(1, availableParallelism() - 1),
  demo: 1,
});

export type Runner = {
  register: (kind: string, spec: JobSpec) => void;
  start: (kind: string, params?: unknown) => string;
  cancel: (jobId: string) => void;
  retry: (jobId: string) => void;
  resume: (jobId: string) => void;
  dismiss: (jobId: string) => void;
  list: () => JobView[];
};

export function createRunner(
  db: Database.Database,
  onUpdate: (job: JobView) => void,
  limits: Limits = defaultLimits(),
): Runner {
  const specs = new Map<string, JobSpec>();
  const active = new Map<
    string,
    { controller: AbortController; jobClass: JobClass }
  >();

  const jobStmt = db.prepare(
    `SELECT id, kind, state, progress, step_label, error, params_json FROM jobs WHERE id = ?`,
  );
  const stepsStmt = db.prepare(
    `SELECT id, job_id, name, position, label, state, output_json, error
     FROM job_steps WHERE job_id = ? ORDER BY position`,
  );

  function viewOf(jobId: string): JobView | null {
    const job = jobStmt.get(jobId) as JobRow | undefined;
    if (!job) return null;
    const steps = stepsStmt.all(jobId) as StepRow[];
    return {
      id: job.id,
      kind: job.kind,
      state: job.state,
      progress: job.progress,
      stepLabel: job.step_label,
      error: job.error,
      steps: steps.map((step) => ({
        name: step.name,
        label: step.label,
        state: step.state,
      })),
    };
  }

  function publish(jobId: string): void {
    const view = viewOf(jobId);
    if (view) onUpdate(view);
  }

  function slotsUsed(jobClass: JobClass): number {
    let used = 0;
    for (const entry of active.values()) {
      if (entry.jobClass === jobClass) used += 1;
    }
    return used;
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
    const entry = active.get(jobId);
    const job = jobStmt.get(jobId) as JobRow | undefined;
    const spec = job ? specs.get(job.kind) : undefined;
    if (!entry || !job || !spec) {
      active.delete(jobId);
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
        if (!specStep) throw new Error(`missing-step:${step.name}`);
        try {
          const output = await specStep.run({
            name: step.name,
            signal: entry.controller.signal,
            params: readParams(jobId),
            setParams: (params) => setParams(jobId, params),
          });
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
        } catch (err) {
          if (entry.controller.signal.aborted || isAbort(err)) {
            db.prepare(
              `UPDATE job_steps SET state = 'pending' WHERE id = ?`,
            ).run(step.id);
            finishCancelled(jobId);
            return;
          }
          const message = err instanceof Error ? err.message : "failed";
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

  function finishCancelled(jobId: string): void {
    db.prepare(
      `UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE id = ?`,
    ).run(Date.now(), jobId);
  }

  function kick(): void {
    const queued = db
      .prepare(
        `SELECT id, kind FROM jobs WHERE state = 'queued' ORDER BY created_at, id`,
      )
      .all() as Array<{ id: string; kind: string }>;
    for (const job of queued) {
      const spec = specs.get(job.kind);
      if (!spec || active.has(job.id)) continue;
      if (slotsUsed(spec.jobClass) >= limits[spec.jobClass]) continue;
      active.set(job.id, {
        controller: new AbortController(),
        jobClass: spec.jobClass,
      });
      void execute(job.id);
    }
  }

  db.prepare(
    `UPDATE job_steps SET state = 'pending' WHERE state = 'running'`,
  ).run();
  db.prepare(
    `UPDATE jobs SET state = 'interrupted', updated_at = ? WHERE state = 'running'`,
  ).run(Date.now());

  return {
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
        spec.steps.forEach((step, index) => {
          stepInsert.run(uuidv7(), jobId, step.name, index, step.label);
        });
      });
      insert();
      publish(jobId);
      kick();
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
          `UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'queued'`,
        )
        .run(Date.now(), jobId);
      if (changed.changes > 0) publish(jobId);
    },
    retry(jobId) {
      const changed = db
        .prepare(
          `UPDATE jobs SET state = 'queued', dismissed = 0, error = NULL, updated_at = ? WHERE id = ? AND state IN ('failed', 'cancelled')`,
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
    resume(jobId) {
      const changed = db
        .prepare(
          `UPDATE jobs SET state = 'queued', dismissed = 0, updated_at = ? WHERE id = ? AND state = 'interrupted'`,
        )
        .run(Date.now(), jobId);
      if (changed.changes === 0) return;
      publish(jobId);
      kick();
    },
    dismiss(jobId) {
      if (active.has(jobId)) return;
      const view = viewOf(jobId);
      if ((view?.kind === "plan-build" || view?.kind === "quiz-build") && ["failed", "cancelled", "succeeded"].includes(view.state)) {
        db.prepare("UPDATE jobs SET dismissed = 1 WHERE id = ?").run(jobId);
        publish(jobId);
        return;
      }
      const changed = db
        .prepare(
          `DELETE FROM jobs WHERE id = ? AND state IN ('failed', 'cancelled', 'succeeded')`,
        )
        .run(jobId);
      if (changed.changes > 0 && view) onUpdate({ ...view, state: "cancelled" });
    },
    list() {
      const rows = db
        .prepare(
          `SELECT id FROM jobs
           WHERE dismissed = 0 AND state IN ('queued', 'running', 'failed', 'cancelled', 'interrupted')
           ORDER BY created_at`,
        )
        .all() as Array<{ id: string }>;
      return rows.flatMap((row) => {
        const view = viewOf(row.id);
        return view ? [view] : [];
      });
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
