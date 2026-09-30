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
});
