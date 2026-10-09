import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { uuidv7 } from "../../shared/ids";
import { openDatabase } from "../db/connection";
import { createRunner, type JobSpec } from "./runner";

const opened: Array<{ close: () => void }> = [];

function db() {
  const database = openDatabase(
    join(mkdtempSync(join(tmpdir(), "pyxis-job-")), "pyxis.db"),
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
