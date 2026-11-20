import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import type { AutoProvider } from "./auto";
import {
  benchEngine,
  clearBench,
  clearLimitBefore,
  configureSignOuts,
  DEFAULT_LIMIT_MS,
  engineClock,
  isBenched,
  isMissing,
  limitedUntil,
  limitIsGuess,
} from "./bench";
import { readOrder, signOutStore } from "./choice";
import { FunnelError, getFunnel, runTurn, type EngineResult } from "./funnel";
import { generate, setFallbackListener } from "./generate";
import { engineHandlers } from "./handlers";
import { rememberOrder, rememberReady, selectionFor } from "./selection";
vi.mock("./funnel", async (original) => {
  const actual = await original<typeof import("./funnel")>();
  return { ...actual, getFunnel: vi.fn(actual.getFunnel), runTurn: vi.fn() };
});

const efforts = ["low", "medium", "high"].map((id) => ({ id, label: id }));
const models: Record<string, string[]> = {
  claude: ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-5-5"],
  codex: ["gpt-6-sol", "gpt-5.6-terra", "gpt-6-luna"],
  antigravity: ["gemini-3.8-flash", "gemini-3.1-pro"],
};
const ids = ["claude", "codex", "antigravity"] as const;

/** Three signed-in CLIs. `installed` and `rateLimits` can be changed by a test. */
function useFunnel(options: { installed?: Record<string, boolean>; rateLimits?: (id: string) => Promise<unknown> } = {}) {
  const provider = { capabilities: { access: ["none"], effort: true, fast: false } };
  const refreshed: string[] = [];
  vi.mocked(getFunnel).mockImplementation(
    () =>
      ({
        providers: Object.fromEntries(ids.map((id) => [id, provider])),
        overview: async () =>
          ids.map((id) => ({
            id,
            displayName: id,
            installation: { installed: options.installed?.[id] ?? true, version: id === "antigravity" ? "1.5.13" : "1.0.0" },
            auth: { loggedIn: true },
            capabilities: provider.capabilities,
          })),
        models: async (id: string) => models[id]!.map((model) => ({ id: model, name: model, efforts })),
        refresh: (id: string) => refreshed.push(id),
        rateLimits: options.rateLimits ?? (async () => Promise.reject(new Error("unsupported"))),
      }) as unknown as ReturnType<typeof getFunnel>,
  );
  return refreshed;
}

const ready: AutoProvider[] = ids.map((id) => ({
  id,
  kind: "cli",
  effort: true,
  models: models[id]!.map((model) => ({ id: model, efforts: [] })),
}));

function result(provider: string): EngineResult {
  return { text: "ciao", model: models[provider]![0]!, provider, inputTokens: 1 };
}

/** What a CLI throws when the account is out of requests, with the reset time CLI Funnel attaches when it knows it. */
const limited = (resetAt?: string) =>
  Object.assign(new Error("You've hit your usage limit"), {
    code: "cli-failed",
    limit: { kind: "quota", detail: "You've hit your usage limit", ...(resetAt ? { resetAt } : {}) },
  });

/** A database whose chat task Pyxis chose, on `provider`. */
function automaticChat(provider: string) {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('chat', ?, 1)").run(
    JSON.stringify({ provider, model: models[provider]![0], auto: true }),
  );
  rememberReady(ready);
  return db;
}

/** Runs one automatic chat call and returns the tools it tried. `out` fail with `error`. */
async function ask(db: ReturnType<typeof openDatabase>, out: readonly string[], error: () => unknown = limited) {
  const asked: string[] = [];
  const output = await generate({
    selection: selectionFor(db, "chat"),
    prompt: "hi",
    run: async (input) => {
      asked.push(input.selection.provider);
      if (out.includes(input.selection.provider)) throw error();
      return result(input.selection.provider);
    },
  });
  return { asked, output };
}

afterEach(() => {
  clearBench();
  rememberReady([]);
  rememberOrder(null);
  setFallbackListener(undefined);
  vi.mocked(runTurn).mockReset();
  vi.useRealTimers();
});

describe("the saved order of the student's tools", () => {
  it("starts with none, is kept across launches and gives every automatic task to the first tool", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    useFunnel();
    expect(handlers.choice().order).toBeNull();
    const shared = await handlers.autoConfigure({});
    // Never touched: the work is shared among the ready tools as before.
    expect(new Set(Object.values(shared.features).map((row) => row.provider)).size).toBeGreaterThan(1);

    handlers.reorder({ order: ["codex", "antigravity", "claude"] });
    expect(readOrder(db)).toEqual(["codex", "antigravity", "claude"]);
    expect(engineHandlers(db, () => undefined).choice().order).toEqual(["codex", "antigravity", "claude"]);
    const listed = await handlers.autoConfigure({});
    expect(new Set(Object.values(listed.features).map((row) => row.provider))).toEqual(new Set(["codex"]));

    // Back to none: Pyxis shares the work again.
    handlers.reorder({ order: null });
    expect(handlers.choice().order).toBeNull();
    expect((await handlers.autoConfigure({})).features).toEqual(shared.features);
    db.close();
  });

  it("leaves a task the student pinned to a model where it is", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    useFunnel();
    await handlers.autoConfigure({});
    handlers.setFeature({ feature: "chat", provider: "codex", model: "gpt-6-luna" });
    handlers.reorder({ order: ["claude", "codex", "antigravity"] });
    const { features } = await handlers.autoConfigure({});
    expect(features.chat).toEqual({ provider: "codex", model: "gpt-6-luna" });
    expect(features.lesson?.provider).toBe("claude");
    db.close();
  });

  it("never uses a tool the student turned off, first of the list or not", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    useFunnel();
    handlers.reorder({ order: ["antigravity", "claude", "codex"] });
    handlers.choose({ allowed: ["claude", "codex"] });
    const { features } = await handlers.autoConfigure({});
    expect(new Set(Object.values(features).map((row) => row.provider))).toEqual(new Set(["claude"]));
    // A task that fails falls back on the tools that are left, in the list's order.
    const chat = automaticChat("claude");
    rememberReady(ready.filter((provider) => provider.id !== "antigravity"));
    rememberOrder(["antigravity", "claude", "codex"]);
    expect((await ask(chat, ["claude"])).asked).toEqual(["claude", "codex"]);
    chat.close();
    db.close();
  });

  it("refuses an empty list, an unknown tool and an API key", () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    useFunnel();
    expect(() => handlers.reorder({ order: [] })).toThrow();
    expect(() => handlers.reorder({ order: ["nope"] })).toThrow();
    expect(() => handlers.reorder({ order: ["claude", "openai-api"] })).toThrow();
    expect(readOrder(db)).toBeNull();
    db.close();
  });
});

describe("work that moves to the next tool of the list", () => {
  it("goes on with the next tool in the student's order, and says so once", async () => {
    const db = automaticChat("antigravity");
    rememberOrder(["antigravity", "codex", "claude"]);
    const heard: unknown[] = [];
    setFallbackListener((event) => heard.push(event));
    const first = await ask(db, ["antigravity"]);
    expect(first.asked).toEqual(["antigravity", "codex"]);
    expect(first.output.fallback).toEqual({ from: "Gemini", to: "ChatGPT", reason: "limit" });
    // The next call goes straight to the second tool, without a second notice.
    const second = await ask(db, ["antigravity"]);
    expect(second.asked).toEqual(["codex"]);
    expect(heard).toHaveLength(1);
    db.close();
  });

  it("walks down the list when the next tool is out of requests too", async () => {
    const db = automaticChat("antigravity");
    rememberOrder(["antigravity", "codex", "claude"]);
    const { asked, output } = await ask(db, ["antigravity", "codex"]);
    expect(asked).toEqual(["antigravity", "codex", "claude"]);
    expect(output.fallback).toEqual({ from: "Gemini", to: "Claude", reason: "limit" });
    expect(isBenched("codex")).toBe(true);
    db.close();
  });

  it("shows the last tool's failure when every tool is out", async () => {
    const db = automaticChat("antigravity");
    rememberOrder(["antigravity", "codex", "claude"]);
    const error = await ask(db, ["antigravity", "codex", "claude"]).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: "quota", params: { provider: "claude" } });
    db.close();
  });

  it("moves on from a tool whose program is gone, and leaves it out until a scan finds it again", async () => {
    const db = automaticChat("antigravity");
    rememberOrder(["antigravity", "codex", "claude"]);
    const gone = () => new FunnelError("agy is not installed.", "not-installed");
    const first = await ask(db, ["antigravity"], gone);
    expect(first.asked).toEqual(["antigravity", "codex"]);
    expect(first.output.fallback).toEqual({ from: "Gemini", to: "ChatGPT", reason: "not-installed" });
    expect(isMissing("antigravity")).toBe(true);
    expect((await ask(db, [])).asked).toEqual(["codex"]);

    // The row reads not installed, whatever a detection cached before the call says, until a later scan finds it.
    const handlers = engineHandlers(db, () => undefined);
    useFunnel();
    const row = (await handlers.overview()).find((item) => item.id === "antigravity");
    expect(row?.installed).toBe(true);
    expect(isMissing("antigravity")).toBe(false);
    expect((await ask(db, [])).asked).toEqual(["antigravity"]);
    db.close();
  });

  it("reads the program's detection again and plans without the tool that is gone", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined, { auto: true });
    const refreshed = useFunnel({ installed: { antigravity: false } });
    handlers.reorder({ order: ["antigravity", "claude", "codex"] });
    await handlers.installChanged("antigravity");
    expect(refreshed).toEqual(["antigravity"]);
    expect(new Set(Object.values(handlers.features()).map((row) => row.provider))).toEqual(new Set(["claude"]));
    db.close();
  });

  it("does not move for a failure the next tool would share", async () => {
    const db = automaticChat("antigravity");
    const error = await ask(db, ["antigravity"], () =>
      Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }),
    ).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: "cli-failed" });
    expect(isBenched("antigravity")).toBe(false);
    db.close();
  });
});

describe("a tool that is out of requests", () => {
  const at = Date.parse("2026-11-16T10:00:00Z");

  it("stays out after a restart until the time the tool reported, then is tried again", () => {
    vi.useFakeTimers({ now: at });
    const db = openDatabase(":memory:");
    configureSignOuts(signOutStore(db));
    benchEngine("antigravity", "limit", { resetAt: "2026-11-17T06:00:00Z" });
    expect(limitedUntil("antigravity")).toBe(Date.parse("2026-11-17T06:00:00Z"));

    // A new launch: memory is empty, the workspace still knows.
    clearBench();
    expect(isBenched("antigravity")).toBe(false);
    configureSignOuts(signOutStore(db));
    expect(isBenched("antigravity")).toBe(true);
    expect(limitedUntil("antigravity")).toBe(Date.parse("2026-11-17T06:00:00Z"));

    vi.setSystemTime(Date.parse("2026-11-17T06:00:01Z"));
    expect(isBenched("antigravity")).toBe(false);
    // The reset is forgotten in the workspace as well, so a later launch does not bring it back.
    clearBench();
    configureSignOuts(signOutStore(db));
    expect(limitedUntil("antigravity")).toBeUndefined();
    expect(signOutStore(db).loadLimits()).toEqual([]);
    db.close();
  });

  it("forgets at launch a limit that reset while Pyxis was closed", () => {
    vi.useFakeTimers({ now: at });
    const db = openDatabase(":memory:");
    configureSignOuts(signOutStore(db));
    benchEngine("codex", "limit", { resetAt: "2026-11-16T12:00:00Z" });
    clearBench();
    vi.setSystemTime(Date.parse("2026-11-16T12:30:00Z"));
    configureSignOuts(signOutStore(db));
    expect(isBenched("codex")).toBe(false);
    expect(signOutStore(db).loadLimits()).toEqual([]);
    db.close();
  });

  it("waits 30 minutes when the tool names no reset time, or as long as it asked", () => {
    vi.useFakeTimers({ now: at });
    benchEngine("antigravity", "limit");
    expect(limitedUntil("antigravity")).toBe(at + DEFAULT_LIMIT_MS);
    expect(limitIsGuess("antigravity")).toBe(true);
    benchEngine("openai-api", "limit", { retryAfterMs: 90_000 });
    expect(limitedUntil("openai-api")).toBe(at + 90_000);
    expect(limitIsGuess("openai-api")).toBe(false);
  });

  it("is marked even when no other tool can answer, and for a model the student pinned", async () => {
    // The reset is a date in the future of the test's clock, which is why the clock is set.
    vi.useFakeTimers({ now: at });
    const db = automaticChat("claude");
    rememberReady(ready.filter((provider) => provider.id === "claude"));
    await expect(ask(db, ["claude"], () => limited("2026-12-01T00:00:00Z"))).rejects.toMatchObject({ code: "quota" });
    expect(limitedUntil("claude")).toBe(Date.parse("2026-12-01T00:00:00Z"));

    clearBench();
    db.prepare("UPDATE feature_engines SET selection_json = ?").run(
      JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
    );
    rememberReady(ready);
    const pinned = await ask(db, ["claude"]).catch((err: unknown) => err);
    // A pinned model keeps its tool and shows the failure, and the tool still reads out of requests.
    expect(pinned).toMatchObject({ code: "quota" });
    expect(isBenched("claude")).toBe(true);
    db.close();
  });

  it("is back as soon as a call to it answers, unless the limit was hit after that call began", async () => {
    const db = automaticChat("claude");
    db.prepare("UPDATE feature_engines SET selection_json = ?").run(
      JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
    );
    benchEngine("claude", "limit", { resetAt: "2099-01-01T00:00:00Z" });
    // The pinned call still goes to it, and its answer shows it has requests again.
    expect((await ask(db, [])).asked).toEqual(["claude"]);
    expect(isBenched("claude")).toBe(false);

    // A call already running when the limit is hit says nothing about the requests left.
    await generate({
      selection: selectionFor(db, "chat"),
      prompt: "hi",
      run: async () => {
        benchEngine("claude", "limit", { resetAt: "2099-01-01T00:00:00Z" });
        return result("claude");
      },
    });
    expect(isBenched("claude")).toBe(true);
    db.close();
  });

  it("shows on its row when it is back, and a Prova that hits the limit marks it too", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    useFunnel();
    const rowOf = async (id: string) => (await handlers.overview()).find((row) => row.id === id);
    expect((await rowOf("codex"))?.limitedUntil).toBeNull();
    vi.mocked(runTurn).mockRejectedValueOnce(limited("2099-01-01T00:00:00Z"));
    await expect(handlers.test({ provider: "codex" })).rejects.toMatchObject({ code: "quota" });
    expect((await rowOf("codex"))?.limitedUntil).toBe(Date.parse("2099-01-01T00:00:00Z"));
    // A Prova that answers clears it.
    vi.mocked(runTurn).mockResolvedValueOnce(result("codex"));
    await handlers.test({ provider: "codex" });
    expect((await rowOf("codex"))?.limitedUntil).toBeNull();
    db.close();
  });

  it("takes the reset time from the tool's usage report when the failure named none", async () => {
    vi.useFakeTimers({ now: at });
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    const asked: string[] = [];
    useFunnel({
      rateLimits: async (id) => {
        asked.push(id);
        return { provider: id, limit: { kind: "quota", detail: "", resetAt: "2026-11-17T07:00:00Z" } };
      },
    });
    benchEngine("antigravity", "limit");
    await handlers.limitChanged("antigravity");
    expect(limitedUntil("antigravity")).toBe(Date.parse("2026-11-17T07:00:00Z"));
    // A limit that came with its time is not asked about.
    benchEngine("claude", "limit", { resetAt: "2026-11-16T15:00:00Z" });
    await handlers.limitChanged("claude");
    expect(asked).toEqual(["antigravity"]);
    expect(limitedUntil("claude")).toBe(Date.parse("2026-11-16T15:00:00Z"));
    db.close();
  });

  it("does not let a usage report asked about one limit replace the next limit the tool hits", async () => {
    vi.useFakeTimers({ now: at });
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    let answer!: (report: unknown) => void;
    useFunnel({ rateLimits: () => new Promise((resolve) => (answer = resolve)) });
    benchEngine("antigravity", "limit");
    const asking = handlers.limitChanged("antigravity");
    // The tool answers a call and is back, then hits its limit again with no reset time: a new limit, a new guess.
    clearLimitBefore("antigravity", engineClock());
    expect(limitedUntil("antigravity")).toBeUndefined();
    benchEngine("antigravity", "limit");
    answer({ provider: "antigravity", limit: { kind: "quota", detail: "", resetAt: "2026-11-17T07:00:00Z" } });
    await asking;
    // The report was about the first limit, so the second keeps its own guess, which its own report may still replace.
    expect(limitedUntil("antigravity")).toBe(at + DEFAULT_LIMIT_MS);
    expect(limitIsGuess("antigravity")).toBe(true);
    db.close();
  });

  it("clears a refined limit for a test that began after the failure, since the report does not date the failure again", async () => {
    vi.useFakeTimers({ now: at });
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    let answer!: (report: unknown) => void;
    useFunnel({ rateLimits: () => new Promise((resolve) => (answer = resolve)) });
    benchEngine("antigravity", "limit");
    const asking = handlers.limitChanged("antigravity");
    // A test starts while the report is on its way, and the report then moves the limit to the tool's own time.
    const testStarted = engineClock();
    answer({ provider: "antigravity", limit: { kind: "quota", detail: "", resetAt: "2026-11-17T07:00:00Z" } });
    await asking;
    expect(limitedUntil("antigravity")).toBe(Date.parse("2026-11-17T07:00:00Z"));
    // The limit was hit before the test began, so the test that answers shows the tool has requests.
    clearLimitBefore("antigravity", testStarted);
    expect(limitedUntil("antigravity")).toBeUndefined();
    db.close();
  });

  it("keeps Pyxis's 30 minutes when the tool has no usage report", async () => {
    vi.useFakeTimers({ now: at });
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    useFunnel();
    benchEngine("antigravity", "limit");
    await handlers.limitChanged("antigravity");
    expect(limitedUntil("antigravity")).toBe(at + DEFAULT_LIMIT_MS);
    db.close();
  });
});
