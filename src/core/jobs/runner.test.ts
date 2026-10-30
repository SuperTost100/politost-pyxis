import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** How many times the runner has waited for a free slot; the wait itself is unchanged. */
const slotWaits = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...actual,
    setTimeout: ((...args: Parameters<typeof actual.setTimeout>) => {
      slotWaits.count += 1;
      return actual.setTimeout(...args);
    }) as typeof actual.setTimeout,
  };
});
import { uuidv7 } from "../../shared/ids";
import { IpcError, type JobView } from "../../shared/ipc";
import { openDatabase } from "../db/connection";
import { createRunner, trackedJob, type JobSpec } from "./runner";
import { tempDir } from "../test-temp";

const opened: Array<{ close: () => void }> = [];

function db() {
  const database = openDatabase(
    join(tempDir("pyxis-job-"), "pyxis.db"),
  );
  opened.push(database);
  return database;
}

function stateOf(database: ReturnType<typeof db>, jobId: string): string {
  const row = database
    .prepare(`SELECT state FROM jobs WHERE id = ?`)
    .get(jobId) as {
    state: string;
  };
  return row.state;
}

async function until(
  database: ReturnType<typeof db>,
  jobId: string,
  states: string[],
): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    const state = stateOf(database, jobId);
    if (states.includes(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout:${stateOf(database, jobId)}`);
}

afterEach(() => {
  for (const database of opened) database.close();
  opened.length = 0;
});

describe("job runner", () => {
  it("tells a job kind its job ended cancelled, also when it was cancelled before its step ran", async () => {
    const database = db();
    const seen: unknown[] = [];
    const runner = createRunner(database, () => {}, { "model-cli": 1, "model-api": 1, local: 0, demo: 1 });
    runner.register("waits", {
      jobClass: "local",
      onCancelled: (params) => seen.push(params),
      steps: [{ name: "run", label: "run", run: async () => null }],
    });
    const jobId = runner.start("waits", { sourceId: "s" });
    runner.cancel(jobId);
    expect(stateOf(database, jobId)).toBe("cancelled");
    expect(seen).toEqual([{ sourceId: "s" }]);
  });

  it("starts interactive work next to busy background slots, limited among interactive jobs only", async () => {
    const database = db();
    const runner = createRunner(database, () => {}, { "model-cli": 1, "model-api": 1, local: 1, demo: 1 });
    const release: Array<() => void> = [];
    const held: JobSpec["steps"] = [
      { name: "call", label: "call", run: () => new Promise<void>((resolve) => release.push(resolve)) },
    ];
    runner.register("background", { jobClass: "model-cli", steps: held });
    runner.register("check", { jobClass: "model-cli", interactive: true, steps: held });
    const busy = runner.start("background");
    const waiting = runner.start("background");
    await until(database, busy, ["running"]);
    const first = runner.start("check");
    const second = runner.start("check");
    // The check runs beside the background call; a second check waits for the first, not for the background.
    await until(database, first, ["running"]);
    expect(stateOf(database, second)).toBe("queued");
    expect(stateOf(database, waiting)).toBe("queued");
    release.shift()!();
    // The background call ended, but the running check still takes the class's one slot from new background work.
    await until(database, busy, ["succeeded"]);
    expect(stateOf(database, waiting)).toBe("queued");
    release.shift()!();
    await until(database, second, ["running"]);
    release.shift()!();
    await until(database, waiting, ["running"]);
    release.shift()!();
    await until(database, waiting, ["succeeded"]);
  });

  it("treats dismissing an interrupted job as giving it up, and a finished one as not", async () => {
    const database = db();
    const seen: unknown[] = [];
    const runner = createRunner(database, () => {});
    runner.register("long", {
      jobClass: "local",
      onCancelled: (params) => seen.push(params),
      steps: [{ name: "run", label: "run", run: async () => null }],
    });
    const now = Date.now();
    for (const [id, state] of [["cut", "interrupted"], ["done", "failed"]] as const)
      database
        .prepare(
          `INSERT INTO jobs (id, kind, params_json, state, progress, created_at, updated_at) VALUES (?, 'long', ?, ?, 0, ?, ?)`,
        )
        .run(id, JSON.stringify({ sourceId: id }), state, now, now);
    runner.dismiss("cut");
    runner.dismiss("done");
    expect(seen).toEqual([{ sourceId: "cut" }]);
  });

  it("moves a job's progress within a long step, inside that step's share", async () => {
    const database = db();
    const seen: number[] = [];
    const runner = createRunner(database, (job) => seen.push(job.progress));
    runner.register("pages", {
      jobClass: "local",
      steps: [
        { name: "first", label: "first", run: async () => null },
        {
          name: "read",
          label: "read",
          run: async (ctx) => {
            ctx.progress(0.5);
            ctx.progress(7);
            return null;
          },
        },
      ],
    });
    const jobId = runner.start("pages");
    expect(await until(database, jobId, ["succeeded"])).toBe("succeeded");
    // Half of the second step is three quarters of the job, and a fraction past 1 stops at the step's end.
    expect(seen).toContain(0.75);
    expect(seen).toContain(1);
    expect(seen.every((value) => value <= 1)).toBe(true);
  });

  it("does not start queued work before initial credentials are applied", async () => {
    const database = db();
    const runner = createRunner(database, () => {}, undefined, true);
    let called = false;
    runner.register("credentials", {
      jobClass: "model-api",
      steps: [
        {
          name: "run",
          label: "run",
          run: async () => {
            called = true;
          },
        },
      ],
    });
    const job = runner.start("credentials");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(called).toBe(false);
    expect(stateOf(database, job)).toBe("queued");
    runner.activate();
    await until(database, job, ["succeeded"]);
    expect(called).toBe(true);
  });

  it("fails a job whose stored step an update no longer knows", async () => {
    const database = db();
    const runner = createRunner(database, () => {}, undefined, true);
    runner.register("renamed", {
      jobClass: "local",
      steps: [{ name: "current", label: "current", run: async () => 1 }],
    });
    const job = runner.start("renamed");
    database
      .prepare("UPDATE job_steps SET name = 'removed' WHERE job_id = ?")
      .run(job);
    runner.activate();
    expect(await until(database, job, ["failed", "running"])).toBe("failed");
    expect(
      database.prepare("SELECT error FROM jobs WHERE id = ?").get(job),
    ).toEqual({ error: "missing-step:removed" });
  });

  it("publishes the title and step states, never step outputs", async () => {
    const database = db();
    const views: JobView[] = [];
    const runner = createRunner(database, (view) => views.push(view), undefined, true);
    runner.register("titled", {
      jobClass: "local",
      title: (params) => (params as { name: string }).name,
      steps: [{ name: "tree", label: "tree", run: async () => ({ topics: ["long"] }) }],
    });
    const job = runner.start("titled", { name: "Fisica" });
    runner.activate();
    await until(database, job, ["succeeded"]);
    expect(views.at(-1)).toEqual({
      id: job,
      kind: "titled",
      title: "Fisica",
      state: "succeeded",
      progress: 1,
      stepLabel: null,
      error: null,
      steps: [{ name: "tree", label: "tree", state: "succeeded" }],
      updatedAt: expect.any(Number),
    });
  });

  it("leaves a retired step out of new jobs and still runs it for a saved one", async () => {
    const database = db();
    const runner = createRunner(database, () => {}, undefined, true);
    const ran: string[] = [];
    const step = (name: string, retired?: boolean) => ({
      name,
      label: name,
      retired,
      run: async () => ran.push(name),
    });
    runner.register("steps", { jobClass: "local", steps: [step("first"), step("old", true), step("last")] });
    const fresh = runner.start("steps");
    const saved = runner.start("steps");
    database
      .prepare("INSERT INTO job_steps (id, job_id, name, position, label, state) VALUES (?, ?, 'old', 5, 'old', 'pending')")
      .run(uuidv7(), saved);
    const names = (job: string) =>
      (database.prepare("SELECT name FROM job_steps WHERE job_id = ? ORDER BY position").all(job) as Array<{
        name: string;
      }>).map((row) => row.name);
    expect(names(fresh)).toEqual(["first", "last"]);
    runner.activate();
    await until(database, fresh, ["succeeded"]);
    await until(database, saved, ["succeeded"]);
    expect(names(saved)).toEqual(["first", "last", "old"]);
    expect(ran.filter((name) => name === "old")).toEqual(["old"]);
  });

  it("records an engine failure as its code, then the engine's own text", async () => {
    const database = db();
    const runner = createRunner(database, () => {}, undefined, true);
    const signedOut = new IpcError(
      "not-logged-in",
      "engines.errors.not-logged-in",
      {},
      "Please run /login",
    );
    runner.register("signed-out", {
      jobClass: "local",
      steps: [
        {
          name: "run",
          label: "run",
          run: async () => {
            throw signedOut;
          },
        },
      ],
    });
    runner.register("missing", {
      jobClass: "local",
      steps: [
        {
          name: "run",
          label: "run",
          run: async () => {
            throw new IpcError(
              "engine-missing",
              "engines.errors.engine-missing",
            );
          },
        },
      ],
    });
    runner.activate();
    const first = runner.start("signed-out");
    const second = runner.start("missing");
    await until(database, first, ["failed"]);
    await until(database, second, ["failed"]);
    const error = (id: string) =>
      (
        database.prepare("SELECT error FROM jobs WHERE id = ?").get(id) as {
          error: string;
        }
      ).error;
    expect(error(first)).toBe("not-logged-in: Please run /login");
    expect(error(second)).toBe("engine-missing");
  });

  it("reacquires the local limit after two passive steps finish together", async () => {
    const database = db();
    const runner = createRunner(database, () => {}, {
      "model-cli": 2,
      "model-api": 4,
      local: 1,
      demo: 1,
    });
    let releasePassive!: () => void,
      releaseLocal!: () => void,
      firstLocal!: () => void;
    const passive = new Promise<void>((resolve) => {
      releasePassive = resolve;
    });
    const local = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      firstLocal = resolve;
    });
    let waiting = 0,
      working = 0,
      maximum = 0;
    runner.register("handoff", {
      jobClass: "local",
      steps: [
        {
          name: "wait",
          label: "wait",
          jobClass: null,
          run: async () => {
            waiting++;
            await passive;
          },
        },
        {
          name: "local",
          label: "local",
          run: async () => {
            working++;
            maximum = Math.max(maximum, working);
            firstLocal();
            await local;
            working--;
          },
        },
      ],
    });
    const first = runner.start("handoff"),
      second = runner.start("handoff");
    while (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    releasePassive();
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(maximum).toBe(1);
    releaseLocal();
    await until(database, first, ["succeeded"]);
    await until(database, second, ["succeeded"]);
    expect(maximum).toBe(1);
  });

  it("keeps insertion order when queued jobs share a timestamp", async () => {
    const database = db();
    const runner = createRunner(database, () => {}, {
      "model-cli": 2,
      "model-api": 4,
      local: 1,
      demo: 1,
    });
    const entered: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const insert = database.prepare(
      "INSERT INTO jobs (id, kind, params_json, state, progress, created_at, updated_at) VALUES (?, 'fifo', ?, 'queued', 0, 100, 100)",
    );
    for (const id of ["z-first", "a-second"]) {
      insert.run(id, JSON.stringify({ id }));
      database
        .prepare(
          "INSERT INTO job_steps (id, job_id, name, position, label, state) VALUES (?, ?, 'hold', 0, 'hold', 'pending')",
        )
        .run(uuidv7(), id);
    }
    runner.register("fifo", {
      jobClass: "local",
      steps: [
        {
          name: "hold",
          label: "hold",
          run: async ({ params }) => {
            entered.push((params as { id: string }).id);
            if (entered.length === 1) await gate;
          },
        },
      ],
    });
    await until(database, "z-first", ["running"]);
    expect(entered).toEqual(["z-first"]);
    expect(stateOf(database, "a-second")).toBe("queued");
    release();
    await until(database, "a-second", ["succeeded"]);
    expect(entered).toEqual(["z-first", "a-second"]);
  });

  it("runs three steps, skips finished ones on retry, and keeps the limit", async () => {
    const database = db();
    const calls = { one: 0, two: 0, three: 0 };
    let secondTries = 0;
    const spec: JobSpec = {
      jobClass: "local",
      steps: [
        {
          name: "one",
          label: "one",
          run: async () => {
            calls.one += 1;
            return "one";
          },
        },
        {
          name: "two",
          label: "two",
          run: async () => {
            calls.two += 1;
            secondTries += 1;
            if (secondTries === 1) throw new Error("boom");
            return "two";
          },
        },
        {
          name: "three",
          label: "three",
          run: async () => {
            calls.three += 1;
            return "three";
          },
        },
      ],
    };
    const runner = createRunner(database, () => {}, {
      "model-cli": 2,
      "model-api": 4,
      local: 1,
      demo: 1,
    });
    runner.register("sample", spec);
    const failed = runner.start("sample", {});
    expect(await until(database, failed, ["failed"])).toBe("failed");
    expect(calls).toEqual({ one: 1, two: 1, three: 0 });
    const output = database
      .prepare(
        `SELECT output_json FROM job_steps WHERE job_id = ? AND name = 'one'`,
      )
      .get(failed) as { output_json: string };
    expect(output.output_json).toBe(JSON.stringify("one"));

    runner.retry(failed);
    expect(await until(database, failed, ["succeeded"])).toBe("succeeded");
    expect(calls).toEqual({ one: 1, two: 2, three: 1 });

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    runner.register("gated", {
      jobClass: "local",
      steps: [
        {
          name: "hold",
          label: "hold",
          run: async () => {
            entered += 1;
            if (entered === 1) await gate;
          },
        },
      ],
    });
    const first = runner.start("gated");
    const second = runner.start("gated");
    await until(database, first, ["running"]);
    expect(stateOf(database, second)).toBe("queued");
    expect(entered).toBe(1);
    release();
    expect(await until(database, first, ["succeeded"])).toBe("succeeded");
    expect(await until(database, second, ["succeeded"])).toBe("succeeded");
  });

  it("cancels the running step and leaves later steps untouched", async () => {
    const database = db();
    const runner = createRunner(database, () => {});
    let started: () => void = () => {};
    const startedGate = new Promise<void>((resolve) => {
      started = resolve;
    });
    runner.register("cancellable", {
      jobClass: "demo",
      steps: [
        { name: "one", label: "one", run: async () => "one" },
        {
          name: "two",
          label: "two",
          run: (ctx) => {
            started();
            return new Promise((_resolve, reject) => {
              ctx.signal.addEventListener(
                "abort",
                () =>
                  reject(
                    Object.assign(new Error("aborted"), { name: "AbortError" }),
                  ),
                { once: true },
              );
            });
          },
        },
        { name: "three", label: "three", run: async () => "three" },
      ],
    });
    const jobId = runner.start("cancellable");
    await startedGate;
    runner.cancel(jobId);
    expect(await until(database, jobId, ["cancelled"])).toBe("cancelled");
    const third = database
      .prepare(
        `SELECT state, output_json FROM job_steps WHERE job_id = ? AND name = 'three'`,
      )
      .get(jobId) as { state: string; output_json: string | null };
    expect(third.state).toBe("pending");
    expect(third.output_json).toBeNull();
  });

  it("marks a running job interrupted when the runner starts", () => {
    const database = db();
    const jobId = uuidv7();
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO jobs (id, kind, params_json, state, progress, created_at, updated_at)
         VALUES (?, 'demo', '{}', 'running', 0.2, ?, ?)`,
      )
      .run(jobId, now, now);
    database
      .prepare(
        `INSERT INTO job_steps (id, job_id, name, position, label, state)
         VALUES (?, ?, 'two', 1, 'two', 'running')`,
      )
      .run(uuidv7(), jobId);
    const runner = createRunner(database, () => {});
    const view = runner.list().find((job) => job.id === jobId);
    expect(view?.state).toBe("interrupted");
    expect(view?.steps[0]?.state).toBe("pending");
  });

  it("resumes interrupted local work by itself, once per step, and leaves model work waiting", async () => {
    const database = db();
    // A job cut off in `step`, with `done` steps finished before it, as a quit leaves it.
    const cutOff = (kind: string, done: string[], step: string, params: object = {}) => {
      const jobId = uuidv7();
      database
        .prepare(
          `INSERT INTO jobs (id, kind, params_json, state, progress, created_at, updated_at)
           VALUES (?, ?, ?, 'running', 0, ?, ?)`,
        )
        .run(jobId, kind, JSON.stringify(params), Date.now(), Date.now());
      [...done, step].forEach((name, position) =>
        database
          .prepare(
            `INSERT INTO job_steps (id, job_id, name, position, label, state, output_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(uuidv7(), jobId, name, position, name, name === step ? "running" : "succeeded", name === step ? null : "{}"),
      );
      return jobId;
    };
    const local = cutOff("import", ["read"], "index", { file: "a" });
    const notListed = cutOff("other-local", [], "read");
    const modelFirst = cutOff("photo", [], "read");
    const modelDone = cutOff("photo", ["read"], "index");
    const again = cutOff("import", [], "read", { autoResumedAt: "read" });
    const ran: string[] = [];
    const runner = createRunner(database, () => {}, undefined, true);
    const step = (name: string, jobClass?: "local") => ({
      name,
      label: name,
      ...(jobClass ? { jobClass } : {}),
      run: async (ctx: { params: unknown }) => {
        ran.push(`${name}:${JSON.stringify(ctx.params)}`);
        return {};
      },
    });
    runner.register("import", { jobClass: "local", steps: [step("read"), step("index")] });
    runner.register("other-local", { jobClass: "local", steps: [step("read")] });
    // A photo is read by a model first, then indexed locally.
    runner.register("photo", { jobClass: "model-cli", steps: [step("read"), step("index", "local")] });
    expect(runner.resumeLocal(["import", "photo"])).toEqual([local, modelDone]);
    expect(stateOf(database, local)).toBe("queued");
    expect(stateOf(database, modelDone)).toBe("queued");
    // A model step waits for the student, as does a kind not asked for, and a job already resumed at this step.
    expect(stateOf(database, modelFirst)).toBe("interrupted");
    expect(stateOf(database, notListed)).toBe("interrupted");
    expect(stateOf(database, again)).toBe("interrupted");
    runner.activate();
    expect(await until(database, local, ["succeeded"])).toBe("succeeded");
    expect(await until(database, modelDone, ["succeeded"])).toBe("succeeded");
    // Only the unfinished step runs, with the input it had and the step it was resumed at.
    expect(ran.sort()).toEqual([
      'index:{"autoResumedAt":"index"}',
      'index:{"file":"a","autoResumedAt":"index"}',
    ]);
  });

  it("lets a step that ends after its database closed finish quietly, without writing or publishing", async () => {
    const database = db();
    const seen: string[] = [];
    const runner = createRunner(database, (job) => seen.push(job.state));
    let release!: () => void;
    runner.register("slow", {
      jobClass: "local",
      steps: [{ name: "run", label: "run", run: () => new Promise<void>((resolve) => (release = resolve)) }],
    });
    runner.register("failing", {
      jobClass: "local",
      steps: [
        {
          name: "run",
          label: "run",
          run: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw new Error("boom");
          },
        },
      ],
    });
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const slow = runner.start("slow");
      runner.start("failing");
      await until(database, slow, ["running"]);
      const published = seen.length;
      // Core shuts down, or a test ends, while both steps are still going.
      database.close();
      release();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(rejections).toEqual([]);
      expect(seen).toHaveLength(published);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("starts nothing on a closed database: neither a job queued just before nor one waiting for a slot", async () => {
    const database = db();
    const runner = createRunner(database, () => {}, { "model-cli": 1, "model-api": 1, local: 1, demo: 1 });
    let release!: () => void;
    let waiterRan = false;
    runner.register("holder", {
      jobClass: "local",
      steps: [{ name: "run", label: "run", run: () => new Promise<void>((resolve) => (release = resolve)) }],
    });
    // Starts on a free slot, then wants the local slot the holder keeps.
    runner.register("waiter", {
      jobClass: "model-cli",
      steps: [
        { name: "model", label: "model", run: async () => null },
        {
          name: "local",
          label: "local",
          jobClass: "local",
          run: async () => {
            waiterRan = true;
            return null;
          },
        },
      ],
    });
    runner.register("late", { jobClass: "model-api", steps: [{ name: "run", label: "run", run: async () => null }] });
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const holder = runner.start("holder");
      const waiter = runner.start("waiter");
      await until(database, holder, ["running"]);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(stateOf(database, waiter)).toBe("running");
      // A job whose run is scheduled when the database closes: the close lands between the kick and the run.
      runner.start("late");
      await new Promise<void>((resolve) =>
        queueMicrotask(() => {
          database.close();
          resolve();
        }),
      );
      const polled = slotWaits.count;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(rejections).toEqual([]);
      // The holder has not settled; the waiter stopped polling for its slot at the close (at most the wait under way ends).
      expect(slotWaits.count - polled).toBeLessThanOrEqual(1);
      release();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(waiterRan).toBe(false);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("keeps a finished mistake analysis when it is cleared from the list, since its row stops a second analysis", () => {
    const database = db();
    const runner = createRunner(database, () => {});
    const add = database.prepare(
      `INSERT INTO jobs (id, kind, params_json, state, progress, created_at, updated_at) VALUES (?, 'gap-insight', '{}', ?, 1, ?, ?)`,
    );
    const now = Date.now();
    add.run("done", "succeeded", now, now);
    add.run("broken", "failed", now, now);
    runner.dismiss("done");
    runner.dismiss("broken");
    expect(runner.finished().map((job) => job.id)).toEqual([]);
    expect(database.prepare("SELECT id, dismissed FROM jobs ORDER BY id").all()).toEqual([{ id: "done", dismissed: 1 }]);
  });

  it("drops a dismissed job from listeners", () => {
    const database = db();
    const seen: string[] = [];
    const runner = createRunner(database, (job) => seen.push(job.state));
    const jobId = uuidv7();
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO jobs (id, kind, params_json, state, progress, error, created_at, updated_at)
         VALUES (?, 'demo', '{}', 'failed', 0.3, 'boom', ?, ?)`,
      )
      .run(jobId, now, now);
    runner.dismiss(jobId);
    expect(seen).toEqual(["cancelled"]);
    expect(runner.list().some((job) => job.id === jobId)).toBe(false);
  });

  it("lists what finished today, newest first, and leaves out yesterday's and cleared jobs", () => {
    const database = db();
    const runner = createRunner(database, () => {});
    runner.register("long", {
      jobClass: "local",
      steps: [{ name: "run", label: "run", run: async () => null }],
    });
    const now = new Date(2026, 9, 28, 15, 30).getTime();
    const at = (hour: number, minute = 0) => new Date(2026, 9, 28, hour, minute).getTime();
    const add = (id: string, state: string, updatedAt: number, dismissed = 0) =>
      database
        .prepare(
          `INSERT INTO jobs (id, kind, params_json, state, progress, created_at, updated_at, dismissed) VALUES (?, 'long', '{}', ?, 1, 1, ?, ?)`,
        )
        .run(id, state, updatedAt, dismissed);
    add("morning", "succeeded", at(8));
    add("afternoon", "succeeded", at(14, 5));
    add("yesterday", "succeeded", at(23, 59) - 24 * 3_600_000);
    add("cleared", "succeeded", at(9), 1);
    add("broken", "failed", at(10));
    expect(runner.finished(now).map((job) => job.id)).toEqual(["afternoon", "morning"]);
    expect(runner.finished(now)[0]?.updatedAt).toBe(at(14, 5));
  });

  it("lists every job that finished today, however many, so clearing them leaves none behind", () => {
    const database = db();
    const runner = createRunner(database, () => {});
    runner.register("long", {
      jobClass: "local",
      steps: [{ name: "run", label: "run", run: async () => null }],
    });
    const now = new Date(2026, 9, 28, 15, 30).getTime();
    const add = database.prepare(
      `INSERT INTO jobs (id, kind, params_json, state, progress, created_at, updated_at) VALUES (?, 'long', '{}', 'succeeded', 1, 1, ?)`,
    );
    for (let i = 0; i < 120; i += 1) add.run(`done-${i}`, new Date(2026, 9, 28, 8).getTime() + i);
    const listed = runner.finished(now);
    expect(listed).toHaveLength(120);
    for (const job of listed) runner.dismiss(job.id);
    expect(runner.finished(now)).toEqual([]);
  });

  it("says which exam and topic a job is about, running and finished", async () => {
    const database = db();
    const runner = createRunner(database, () => {});
    runner.register("quiz", {
      jobClass: "local",
      about: (params) => ({ exam: "Fisica 1", topic: (params as { topic: string }).topic }),
      steps: [{ name: "run", label: "quiz.generating", run: async () => null }],
    });
    runner.register("grade", {
      jobClass: "local",
      about: () => ({ exam: "Fisica 1", activity: "diagnostic" }),
      ref: () => "a1/q2",
      steps: [{ name: "run", label: "jobs.quizGrading", run: async () => null }],
    });
    const quiz = runner.start("quiz", { topic: "Misure e vettori" });
    const grade = runner.start("grade", {});
    expect(runner.list().find((job) => job.id === quiz)).toMatchObject({ exam: "Fisica 1", topic: "Misure e vettori" });
    await until(database, quiz, ["succeeded"]);
    await until(database, grade, ["succeeded"]);
    const finished = runner.finished();
    expect(finished.find((job) => job.id === quiz)).toMatchObject({ exam: "Fisica 1", topic: "Misure e vettori" });
    expect(finished.find((job) => job.id === grade)).toMatchObject({ activity: "diagnostic", ref: "a1/q2" });
    expect(finished.find((job) => job.id === quiz)).not.toHaveProperty("ref");
    expect(finished.find((job) => job.id === grade)).not.toHaveProperty("topic");
  });

  it("lists a page's own model work while it runs, keeps it once it succeeded, and drops it when it did not", () => {
    const database = db();
    const seen: JobView[] = [];
    const runner = createRunner(database, (job) => seen.push(job));
    const lesson = runner.track("lesson-write", { exam: "Fisica 1", topic: "Misure e vettori" }, "jobs.lessonWriting");
    const running = runner.list();
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({
      kind: "lesson-write",
      state: "running",
      stepLabel: "jobs.lessonWriting",
      topic: "Misure e vettori",
      exam: "Fisica 1",
      inPage: true,
    });
    lesson.progress(0.5);
    expect(runner.list()[0]?.progress).toBe(0.5);
    lesson.finish(true);
    lesson.finish(false);
    expect(runner.list()).toEqual([]);
    expect(seen.at(-1)).toMatchObject({ state: "succeeded", topic: "Misure e vettori" });
    // After a restart the finished entry still says what it was about.
    const again = createRunner(database, () => {});
    again.register("lesson-write", trackedJob);
    expect(again.finished()).toMatchObject([{ kind: "lesson-write", topic: "Misure e vettori", exam: "Fisica 1" }]);
    // Work that fails or stops leaves nothing behind.
    const cards = runner.track("cards-propose", { topic: "Vettori" }, "jobs.cards");
    expect(runner.list()).toHaveLength(1);
    cards.finish(false);
    expect(runner.list()).toEqual([]);
    expect(seen.at(-1)).toMatchObject({ kind: "cards-propose", state: "cancelled" });
    expect(runner.finished().map((job) => job.kind)).toEqual(["lesson-write"]);
  });

  it("notes which engine answered on the job, and forgets it when the job is retried", () => {
    const database = db();
    const seen: JobView[] = [];
    const runner = createRunner(database, (job) => seen.push(job));
    runner.register("long", {
      jobClass: "local",
      steps: [{ name: "run", label: "run", run: async () => null }],
    });
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO jobs (id, kind, params_json, state, progress, created_at, updated_at) VALUES ('j', 'long', '{}', 'failed', 0, ?, ?)`,
      )
      .run(now, now);
    const fallback = { from: "Cursor Agent", to: "Claude Code", reason: "model" as const };
    runner.noteFallback("j", fallback);
    runner.noteFallback("missing", fallback);
    expect(seen.map((job) => job.fallback)).toEqual([fallback]);
    expect(runner.list()[0]?.fallback).toEqual(fallback);
    runner.retry("j");
    expect(runner.list()[0]?.fallback).toBeUndefined();
  });
});

it("waiting local source steps leave model slots available and rolled-back jobs never run", async () => {
  const database = db();
  const runner = createRunner(database, () => {}, {
    local: 3,
    "model-cli": 1,
    "model-api": 1,
    demo: 1,
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  runner.register("waiting-source", {
    jobClass: "local",
    steps: [
      {
        name: "source",
        label: "source",
        run: async () => {
          entered++;
          await gate;
        },
      },
      {
        name: "model",
        label: "model",
        jobClass: "model-cli",
        run: async () => "built",
      },
    ],
  });
  runner.register("grading", {
    jobClass: "model-cli",
    steps: [{ name: "grade", label: "grade", run: async () => "graded" }],
  });
  const first = runner.start("waiting-source");
  const second = runner.start("waiting-source");
  await until(database, first, ["running"]);
  expect(entered).toBe(2);
  const grade = runner.start("grading");
  expect(await until(database, grade, ["succeeded"])).toBe("succeeded");
  let phantomRuns = 0;
  runner.register("phantom", {
    jobClass: "model-cli",
    steps: [
      {
        name: "work",
        label: "work",
        run: async () => {
          phantomRuns++;
        },
      },
    ],
  });
  expect(() =>
    database.transaction(() => {
      runner.start("phantom");
      throw new Error("rollback");
    })(),
  ).toThrow("rollback");
  await new Promise((resolve) => setImmediate(resolve));
  expect(phantomRuns).toBe(0);
  release();
  await until(database, first, ["succeeded"]);
  await until(database, second, ["succeeded"]);
});

it("a source-wait step releases the only local slot for the source import it needs", async () => {
  const database = db();
  const runner = createRunner(database, () => {}, {
    local: 1,
    "model-cli": 1,
    "model-api": 1,
    demo: 1,
  });
  let imported!: () => void;
  const sourceReady = new Promise<void>((resolve) => {
    imported = resolve;
  });
  runner.register("plan-wait", {
    jobClass: "local",
    steps: [
      {
        name: "source",
        label: "source",
        jobClass: null,
        run: async () => sourceReady,
      },
    ],
  });
  runner.register("source-import", {
    jobClass: "local",
    steps: [
      {
        name: "extract",
        label: "extract",
        run: async () => {
          imported();
        },
      },
    ],
  });
  const plan = runner.start("plan-wait");
  const source = runner.start("source-import");
  expect(await until(database, source, ["succeeded"])).toBe("succeeded");
  expect(await until(database, plan, ["succeeded"])).toBe("succeeded");
});

it("dismisses an interrupted study build without deleting its resume checkpoint", async () => {
  const database = db();
  const runner = createRunner(database, () => {}, undefined, true);
  runner.register("cards-build", {
    jobClass: "local",
    steps: [{ name: "cards", label: "jobs.cards", run: async () => true }],
  });
  const job = runner.start("cards-build", { planId: "p", topicId: "t" });
  database.prepare("UPDATE jobs SET state='interrupted' WHERE id=?").run(job);
  runner.dismiss(job);
  expect(runner.list()).toEqual([]);
  expect(
    database.prepare("SELECT state,dismissed FROM jobs WHERE id=?").get(job),
  ).toEqual({ state: "interrupted", dismissed: 1 });
  runner.resume(job);
  runner.activate();
  await until(database, job, ["succeeded"]);
});
