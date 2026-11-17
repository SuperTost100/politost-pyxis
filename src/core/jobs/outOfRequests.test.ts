import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IpcError, type JobView } from "../../shared/ipc";
import { openDatabase } from "../db/connection";
import type { AutoProvider } from "../engine/auto";
import { benchEngine, clearBench, clearLimitBefore, engineClock } from "../engine/bench";
import { generate, setFallbackListener } from "../engine/generate";
import { rememberReady } from "../engine/selection";
import { currentUsageScope } from "../engine/usage";
import { tempDir } from "../test-temp";
import { jobHandlers } from "./handlers";
import { createRunner, type Runner } from "./runner";

const opened: Array<{ close: () => void }> = [];
const runners: Runner[] = [];

function db() {
  const database = openDatabase(join(tempDir("pyxis-out-"), "pyxis.db"));
  opened.push(database);
  return database;
}

type Database = ReturnType<typeof db>;

const stateOf = (database: Database, id: string) =>
  (database.prepare("SELECT state FROM jobs WHERE id = ?").get(id) as { state: string }).state;

async function until(database: Database, id: string, state: string) {
  for (let i = 0; i < 200; i += 1) {
    if (stateOf(database, id) === state) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`timeout: ${stateOf(database, id)}`);
}

const limit = Object.assign(new Error("You've hit your usage limit"), {
  code: "cli-failed",
  limit: { kind: "quota", detail: "You've hit your usage limit" },
});

/** The tools the last automatic choice could use, by id. */
const ready = (...ids: string[]): AutoProvider[] =>
  ids.map((id) => ({
    id,
    kind: "cli",
    effort: false,
    models: [{ id: id === "claude" ? "claude-sonnet-5" : "gpt-5.6-terra", efforts: [] }],
  }));

/** A job whose one step asks a tool for an answer with `selection`, as the app's jobs do, and records who answered. */
function asking(database: Database, selection: Parameters<typeof generate>[0]["selection"], run: (provider: string) => string) {
  const answered: string[] = [];
  const events: unknown[] = [];
  const runner = createRunner(database, (view) => events.push(view), { "model-cli": 2, "model-api": 2, local: 1, demo: 1 });
  runners.push(runner);
  // Core tells the job which tool answered instead, as the server does.
  setFallbackListener((event) => {
    const jobId = currentUsageScope()?.jobId;
    if (jobId) runner.noteFallback(jobId, event);
  });
  runner.register("asks", {
    jobClass: "local",
    steps: [
      {
        name: "ask",
        label: "ask",
        run: async () => {
          const out = await generate({
            selection,
            prompt: "hi",
            run: async (input) => {
              answered.push(input.selection.provider);
              const text = run(input.selection.provider);
              return { text, model: "m", provider: input.selection.provider, inputTokens: 1 };
            },
          });
          return out.text;
        },
      },
    ],
  });
  runner.activate();
  return { runner, answered, events };
}

/** What a tool that is out of requests throws: a pinned model has no other tool to move to, so the job fails. */
const outOfRequests = (provider: string) => {
  if (provider === "codex") throw limit;
  return "ciao";
};

afterEach(() => {
  clearBench();
  rememberReady([]);
  setFallbackListener(undefined);
  for (const database of opened) database.close();
  opened.length = 0;
  runners.length = 0;
  vi.useRealTimers();
});

describe("a job whose tool ran out of requests", () => {
  const pinned = { provider: "codex" as const, model: "gpt-5.6-terra" };

  it("fails with the tool named, and goes on with the tool the student chose, from the step it stopped at", async () => {
    const database = db();
    rememberReady(ready("claude", "codex"));
    const { runner, answered } = asking(database, pinned, outOfRequests);
    const handlers = jobHandlers(runner, false, database);
    const id = runner.start("asks", {});
    await until(database, id, "failed");
    expect((database.prepare("SELECT error FROM jobs WHERE id = ?").get(id) as { error: string }).error).toMatch(
      /^quota \[codex\]:/,
    );
    // The tool's limit is known now, so it is not offered as the next one.
    expect(answered).toEqual(["codex"]);

    handlers.retryWith({ jobId: id, provider: "claude" });
    await until(database, id, "succeeded");
    expect(answered).toEqual(["codex", "claude"]);
    // The finished job says who ran out and who went on.
    const fallback = (database.prepare("SELECT fallback_json FROM jobs WHERE id = ?").get(id) as { fallback_json: string })
      .fallback_json;
    expect(JSON.parse(fallback)).toEqual({ from: "ChatGPT", to: "Claude", reason: "limit" });
  });

  it("refuses a tool that is not one Pyxis can use now, and leaves the job as it was", async () => {
    const database = db();
    rememberReady(ready("claude", "codex"));
    const { runner } = asking(database, pinned, outOfRequests);
    const handlers = jobHandlers(runner, false, database);
    const id = runner.start("asks", {});
    await until(database, id, "failed");
    // Gemini is not signed in, and Claude is out of requests as well.
    expect(() => handlers.retryWith({ jobId: id, provider: "antigravity" })).toThrow(IpcError);
    benchEngine("claude", "limit", { resetAt: "2099-01-01T00:00:00Z" });
    expect(() => handlers.retryWith({ jobId: id, provider: "claude" })).toThrow(IpcError);
    expect(stateOf(database, id)).toBe("failed");
  });

  it("does not send a photo's job to a tool that cannot see it, and lets it go on with one that can", async () => {
    const database = db();
    rememberReady(ready("claude", "agent", "codex"));
    const { runner } = asking(database, pinned, outOfRequests);
    // A photo import that stopped because its tool ran out of requests.
    let calls = 0;
    runner.register("source-import-vision", {
      jobClass: "local",
      steps: [
        {
          name: "read",
          label: "read",
          run: async () => {
            calls += 1;
            if (calls === 1) throw new Error("quota [codex]: You've hit your usage limit");
            return "text";
          },
        },
      ],
    });
    const handlers = jobHandlers(runner, false, database);
    const id = runner.start("source-import-vision", {});
    await until(database, id, "failed");
    // Cursor takes no pictures, so the job is not sent there, and stays as it was.
    expect(() => handlers.retryWith({ jobId: id, provider: "agent" })).toThrow(IpcError);
    expect(stateOf(database, id)).toBe("failed");
    expect(calls).toBe(1);
    // Claude takes them.
    handlers.retryWith({ jobId: id, provider: "claude" });
    await until(database, id, "succeeded");
    expect(calls).toBe(2);
  });

  it("waits until the tool's requests are back, shows when, and starts again by itself", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-16T22:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const database = db();
    rememberReady(ready("codex"));
    let fail = true;
    const { runner, answered, events } = asking(database, pinned, (provider) => {
      if (fail) throw limit;
      return provider;
    });
    const handlers = jobHandlers(runner, false, database);
    const id = runner.start("asks", {});
    await vi.waitFor(() => expect(stateOf(database, id)).toBe("failed"));
    // The reset is the one the tool reported with the limit.
    benchEngine("codex", "limit", { resetAt: "2026-11-17T06:00:00Z" });

    handlers.wait({ jobId: id, wait: true });
    const held = () => runner.list().find((job) => job.id === id) as JobView;
    expect(held().waitingUntil).toBe(Date.parse("2026-11-17T06:00:00Z"));
    expect(stateOf(database, id)).toBe("failed");
    expect((events.at(-1) as JobView).waitingUntil).toBeDefined();

    // Nothing runs before the time; at the time the job starts again and the tool answers.
    await vi.advanceTimersByTimeAsync(7 * 3_600_000);
    expect(answered).toEqual(["codex"]);
    fail = false;
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    await vi.waitFor(() => expect(stateOf(database, id)).toBe("succeeded"));
    expect(answered).toEqual(["codex", "codex"]);
    expect((database.prepare("SELECT 1 FROM settings WHERE key = ?").get(`job-wait:${id}`))).toBeUndefined();
  });

  it("gives the wait up when the student asks, and keeps no wait for a job that is not failed or whose tool is not out", async () => {
    const database = db();
    rememberReady(ready("codex"));
    const { runner } = asking(database, pinned, () => {
      throw limit;
    });
    const handlers = jobHandlers(runner, false, database);
    const id = runner.start("asks", {});
    await until(database, id, "failed");
    // A tool that is not out of requests has no time to wait for.
    clearBench();
    expect(() => handlers.wait({ jobId: id, wait: true })).toThrow(IpcError);
    benchEngine("codex", "limit", { resetAt: "2099-01-01T00:00:00Z" });
    handlers.wait({ jobId: id, wait: true });
    expect((runner.list().find((job) => job.id === id) as JobView).waitingUntil).toBe(Date.parse("2099-01-01T00:00:00Z"));
    handlers.wait({ jobId: id, wait: false });
    expect((runner.list().find((job) => job.id === id) as JobView).waitingUntil).toBeUndefined();
    // A job that is not failed has nothing to wait on.
    expect(runner.hold("no-such-job", Date.now() + 1000)).toBe(false);
  });

  it("goes on with a wait after a restart, and a Chiudi ends it", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-16T22:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const database = db();
    rememberReady(ready("codex"));
    const first = asking(database, pinned, () => {
      throw limit;
    });
    const id = first.runner.start("asks", {});
    await vi.waitFor(() => expect(stateOf(database, id)).toBe("failed"));
    first.runner.hold(id, Date.parse("2026-11-17T06:00:00Z"));
    // A new launch: its runner reads the wait from the workspace.
    const second = asking(database, pinned, () => "ok");
    expect((second.runner.list().find((job) => job.id === id) as JobView).waitingUntil).toBe(
      Date.parse("2026-11-17T06:00:00Z"),
    );
    second.runner.dismiss(id);
    expect(database.prepare("SELECT 1 FROM settings WHERE key = ?").get(`job-wait:${id}`)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(9 * 3_600_000);
    expect(second.answered).toEqual([]);
  });

});

describe("a held job follows its tool's limit", () => {
  const pinned = { provider: "codex" as const, model: "gpt-5.6-terra" };
  const fakeTimers = () => vi.useFakeTimers({ now: Date.parse("2026-11-16T22:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });

  /** A job ChatGPT turned away, held until `resetAt`, on a tool that answers once `fail` is false. */
  async function held(resetAt: string) {
    const database = db();
    rememberReady(ready("codex"));
    const flags = { fail: true };
    const asked = asking(database, pinned, (provider) => {
      if (flags.fail) throw limit;
      return provider;
    });
    const handlers = jobHandlers(asked.runner, false, database);
    const id = asked.runner.start("asks", {});
    await vi.waitFor(() => expect(stateOf(database, id)).toBe("failed"));
    benchEngine("codex", "limit", { resetAt });
    handlers.wait({ jobId: id, wait: true });
    const view = () => asked.runner.list().find((job) => job.id === id) as JobView;
    return { database, id, view, flags, ...asked };
  }

  it("moves the wait when the tool's limit is given another time, and keeps the new time after a restart", async () => {
    fakeTimers();
    const { database, id, view, flags, answered } = await held("2026-11-17T01:00:00Z");
    expect(view().waitingUntil).toBe(Date.parse("2026-11-17T01:00:00Z"));
    // The tool's own usage report says the requests are back later than the first guess.
    benchEngine("codex", "limit", { resetAt: "2026-11-17T06:00:00Z" });
    expect(view().waitingUntil).toBe(Date.parse("2026-11-17T06:00:00Z"));
    // The first time passes: the job still waits for the new one.
    flags.fail = false;
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    expect(stateOf(database, id)).toBe("failed");
    expect(answered).toEqual(["codex"]);
    // A new launch reads the new time, not the first.
    const second = asking(database, pinned, () => "ok");
    expect((second.runner.list().find((job) => job.id === id) as JobView).waitingUntil).toBe(
      Date.parse("2026-11-17T06:00:00Z"),
    );
    await vi.advanceTimersByTimeAsync(5 * 3_600_000);
    await vi.waitFor(() => expect(stateOf(database, id)).toBe("succeeded"));
  });

  it("releases the job at once when a call to the tool answers and clears its limit", async () => {
    fakeTimers();
    const { database, id, flags, answered } = await held("2026-11-18T06:00:00Z");
    flags.fail = false;
    // A call that began after the limit was marked answered, so the tool has requests again.
    clearLimitBefore("codex", engineClock());
    await vi.waitFor(() => expect(stateOf(database, id)).toBe("succeeded"));
    expect(answered).toEqual(["codex", "codex"]);
    expect(database.prepare("SELECT 1 FROM settings WHERE key = ?").get(`job-wait:${id}`)).toBeUndefined();
  });

  it("leaves a job held for another tool alone", async () => {
    fakeTimers();
    const { id, view, runner } = await held("2026-11-17T06:00:00Z");
    runner.retime("claude", null);
    runner.retime("claude", Date.parse("2026-11-20T00:00:00Z"));
    expect(view().waitingUntil).toBe(Date.parse("2026-11-17T06:00:00Z"));
    expect(runner.list().some((job) => job.id === id)).toBe(true);
  });
});
