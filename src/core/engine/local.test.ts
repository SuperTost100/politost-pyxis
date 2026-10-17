import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planAuto, type AutoProvider } from "./auto";
import { openDatabase } from "../db/connection";
import { startFakeOllama, type FakeOllama } from "./fake-ollama";
import { getFunnel } from "./funnel";
import {
  autoConfigureEngines,
  engineHandlers,
  type LocalEvent,
} from "./handlers";
import type { Gpu, Hardware } from "./hardware";
import {
  adviseLocal,
  checkLocalModel,
  localData,
  pullLocalModel,
  readLocal,
  writeLocal,
} from "./local";
import { selectionFor } from "./selection";

const GIB = 1024 ** 3;
const GB = 1e9;

function machine(
  gpus: Gpu[],
  fields: Partial<Omit<Hardware, "gpus">> = {},
): Hardware {
  return {
    platform: "linux",
    ramBytes: 32 * GIB,
    freeDiskBytes: 500 * GB,
    complete: true,
    gpus,
    ...fields,
  };
}
const card = (vendor: Gpu["vendor"], gb: number): Gpu => ({
  vendor,
  name: `${vendor} ${gb} GB`,
  vramBytes: gb * GIB,
  unified: false,
});
const apple = (gb: number): Gpu => ({
  vendor: "apple",
  name: "Apple M2",
  vramBytes: gb * GIB,
  unified: true,
});

describe("local model tiers", () => {
  it("suggests one model per hardware class", () => {
    const model = (hw: Hardware) => adviseLocal(hw).tier?.model ?? null;
    expect(model(machine([card("nvidia", 24)]))).toBe("gemma3:27b");
    // An RX 6900 XT reports a little under 16 GiB.
    expect(
      model(
        machine([
          {
            vendor: "amd",
            name: "1002:73BF",
            vramBytes: 17163091968,
            unified: false,
          },
        ]),
      ),
    ).toBe("gemma3:12b");
    expect(model(machine([card("nvidia", 12)]))).toBe("gemma3:12b");
    expect(model(machine([card("nvidia", 8)]))).toBe("gemma3:4b");
    expect(
      model(machine([apple(8)], { platform: "darwin", ramBytes: 8 * GIB })),
    ).toBe("gemma3:4b");
    expect(model(machine([apple(16)], { platform: "darwin" }))).toBe(
      "gemma3:12b",
    );
    expect(model(machine([apple(36)], { platform: "darwin" }))).toBe(
      "gemma3:27b",
    );
    // The biggest card wins when there are two.
    expect(model(machine([card("nvidia", 4), card("amd", 16)]))).toBe(
      "gemma3:12b",
    );
  });

  it("explains why when the computer cannot run a model at a usable speed", () => {
    const reason = (hw: Hardware) => adviseLocal(hw).reason;
    expect(reason(machine([card("intel", 2)]))).toBe("no-gpu");
    expect(reason(machine([]))).toBe("no-gpu");
    // Ollama runs on the processor in an Intel Mac, even with an AMD card.
    expect(reason(machine([card("amd", 8)], { platform: "darwin" }))).toBe(
      "no-gpu",
    );
    expect(reason(machine([card("nvidia", 4)]))).toBe("vram");
    expect(reason(machine([apple(4)], { platform: "darwin" }))).toBe("vram");
    expect(reason(machine([card("nvidia", 12)], { ramBytes: 4 * GIB }))).toBe(
      "ram",
    );
    expect(reason(machine([], { complete: false }))).toBe("unknown");
    expect(adviseLocal(machine([card("nvidia", 8)])).reason).toBeNull();
  });

  it("steps down to a model that fits the free disk space, and asks for space when none does", () => {
    const tight = machine([card("nvidia", 16)], { freeDiskBytes: 6 * GB });
    expect(adviseLocal(tight)).toMatchObject({
      tier: { model: "gemma3:4b" },
      reason: null,
    });
    expect(adviseLocal(tight, ["gemma3:12b"]).tier?.model).toBe("gemma3:12b");
    expect(
      adviseLocal(machine([card("nvidia", 16)], { freeDiskBytes: 2 * GB })),
    ).toMatchObject({ tier: { model: "gemma3:12b" }, reason: "disk" });
  });

  it("lists Ollama models with sizes, largest first", () => {
    expect(localData.provider).toBe("ollama");
    const sizes = localData.tiers.map((tier) => tier.downloadBytes);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    for (const tier of localData.tiers) {
      expect(tier.model).toMatch(/^[\w.-]+:[\w.-]+$/);
      expect(tier.contextWindow).toBeGreaterThanOrEqual(8192);
    }
  });
});

describe("local model in the automatic choice", () => {
  const local = (structured: boolean): AutoProvider => ({
    id: "ollama",
    kind: "local",
    structured,
    effort: true,
    models: [{ id: "gemma3:12b", efforts: [] }],
  });
  const api: AutoProvider = {
    id: "anthropic-api",
    kind: "api",
    effort: true,
    models: [{ id: "claude-sonnet-5", efforts: [] }],
  };
  const cli: AutoProvider = {
    id: "claude",
    kind: "cli",
    effort: true,
    models: [{ id: "claude-sonnet-5", efforts: [] }],
  };

  it("takes every task, photos included, when it is the only engine and passed the check", () => {
    const plan = planAuto([local(true)]);
    expect(Object.keys(plan).sort()).toEqual(
      ["chat", "default", "grading", "lesson", "map", "plan", "vision"].sort(),
    );
    expect(plan.plan).toEqual({ provider: "ollama", model: "gemma3:12b" });
  });

  it("never builds plans or grades without a passed structured-output check", () => {
    const plan = planAuto([local(false)]);
    expect(plan.plan).toBeUndefined();
    expect(plan.grading).toBeUndefined();
    expect(plan.chat?.provider).toBe("ollama");
  });

  it("comes after a subscription CLI and before a per-token API key", () => {
    expect(planAuto([cli, local(true)]).chat?.provider).toBe("claude");
    expect(planAuto([api, local(true)]).chat?.provider).toBe("ollama");
  });
});

describe("local model check", () => {
  let server: FakeOllama | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
    delete process.env.OLLAMA_HOST;
  });
  const valid = JSON.stringify({
    question: "Where does photosynthesis take place?",
    options: ["Chloroplasts", "Mitochondria", "Nucleus", "Ribosomes"],
    answer: 0,
    explanation: "The passage says it happens in the chloroplasts.",
  });
  const words = (count: number) =>
    Array.from({ length: count }, () => "word").join(" ");

  it("passes a fast model that answers in the required shape", async () => {
    server = await startFakeOllama({
      models: ["gemma3:4b"],
      replies: [{ text: words(60), tokens: 60 }, { text: valid }],
    });
    process.env.OLLAMA_HOST = server.url;
    // The first token at 0 s and the last at 3 s: 59 tokens in 3 s.
    const times = [0, 3000];
    const check = await checkLocalModel("gemma3:4b", {
      now: () => times.shift() ?? 0,
    });
    expect(check).toMatchObject({
      model: "gemma3:4b",
      structured: true,
      passed: true,
    });
    expect(check.failure).toBeUndefined();
    expect(check.tokensPerSecond).toBe(19.7);
    // The structured answer was asked for with the JSON Schema and the context Pyxis sets for this model.
    const chats = server.requests.filter(
      (request) => request.path === "/api/chat",
    );
    expect(chats).toHaveLength(2);
    expect(chats[1]!.body).toMatchObject({
      model: "gemma3:4b",
      format: { type: "object", additionalProperties: false },
      options: { num_ctx: 16384 },
    });
  });

  it("fails a model that is too slow", async () => {
    server = await startFakeOllama({
      models: ["gemma3:4b"],
      replies: [{ text: words(20), tokens: 20 }, { text: valid }],
    });
    process.env.OLLAMA_HOST = server.url;
    // 19 tokens in 10 s.
    const times = [0, 10_000];
    const check = await checkLocalModel("gemma3:4b", {
      now: () => times.shift() ?? 0,
    });
    expect(check).toMatchObject({
      passed: false,
      structured: true,
      failure: "slow",
    });
    expect(check.tokensPerSecond).toBe(1.9);
    expect(check.tokensPerSecond).toBeLessThan(localData.minTokensPerSecond);
  });

  it("fails a model whose structured answer does not match on the first try", async () => {
    server = await startFakeOllama({
      models: ["gemma3:4b"],
      replies: [
        { text: words(60), tokens: 60 },
        {
          text: JSON.stringify({ question: "Too short?", options: ["a", "b"] }),
        },
      ],
    });
    process.env.OLLAMA_HOST = server.url;
    const times = [0, 1000];
    const check = await checkLocalModel("gemma3:4b", {
      now: () => times.shift() ?? 0,
    });
    expect(check).toMatchObject({
      passed: false,
      structured: false,
      failure: "structured",
    });
    // No repair turn: one speed answer and one structured answer.
    expect(server.requests.filter((r) => r.path === "/api/chat")).toHaveLength(
      2,
    );
  });

  it("reports an error when Ollama does not answer", async () => {
    process.env.OLLAMA_HOST = "http://127.0.0.1:9";
    const check = await checkLocalModel("gemma3:4b");
    expect(check).toMatchObject({ passed: false, failure: "error" });
  });
});

describe("local model download", () => {
  let server: FakeOllama | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
    delete process.env.OLLAMA_HOST;
  });

  it("sums the layers against the size the table lists", async () => {
    server = await startFakeOllama({ pull: { bytes: 4 * GB, steps: 4 } });
    process.env.OLLAMA_HOST = server.url;
    const seen: Array<[number, number]> = [];
    await pullLocalModel("gemma3:4b", {
      signal: new AbortController().signal,
      onProgress: (progress) => seen.push([progress.completed, progress.total]),
    });
    // The manifest comes first, before Ollama knows the layer sizes.
    expect(seen[0]).toEqual([0, 3.3 * GB]);
    expect(seen[1]).toEqual([GB, 4 * GB]);
    expect(seen.at(-1)).toEqual([4 * GB + 100, 4 * GB + 100]);
    expect(server.requests.find((r) => r.path === "/api/pull")?.body).toEqual({
      model: "gemma3:4b",
      stream: true,
    });
  });

  it("stops when cancelled and when Ollama reports an error", async () => {
    server = await startFakeOllama({
      pull: { bytes: 10 * GB, steps: 100, delayMs: 20 },
    });
    process.env.OLLAMA_HOST = server.url;
    const abort = new AbortController();
    const pulling = pullLocalModel("gemma3:12b", {
      signal: abort.signal,
      onProgress: (progress) => {
        if (progress.completed >= GB) abort.abort();
      },
    });
    await expect(pulling).rejects.toThrow();
    await server.close();
    server = await startFakeOllama({
      pull: {
        bytes: 1,
        steps: 1,
        error: "pull model manifest: file does not exist",
      },
    });
    process.env.OLLAMA_HOST = server.url;
    await expect(
      pullLocalModel("gemma3:4b", { signal: new AbortController().signal }),
    ).rejects.toThrow("file does not exist");
  });
});

describe("local model handlers", () => {
  let server: FakeOllama | undefined;
  const gpu16: Hardware = machine([card("amd", 16)]);
  const weak: Hardware = machine([card("intel", 1)]);
  const valid = JSON.stringify({
    question: "Where does photosynthesis take place?",
    options: ["Chloroplasts", "Mitochondria", "Nucleus", "Ribosomes"],
    answer: 0,
    explanation: "The passage says it happens in the chloroplasts.",
  });
  beforeEach(() => {
    process.env.OLLAMA_HOST = "http://127.0.0.1:9";
    getFunnel().refresh("ollama");
  });
  // Only the local model: the CLIs signed in on this computer stay out of the test.
  const configure = (db: ReturnType<typeof openDatabase>) =>
    autoConfigureEngines(db, { rows: [] });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    delete process.env.OLLAMA_HOST;
  });

  it("says why on a computer that cannot run a model and refuses to download", async () => {
    const db = openDatabase(":memory:");
    const engines = engineHandlers(db, () => undefined, {
      hardware: async () => weak,
    });
    const state = await engines.local();
    expect(state).toMatchObject({
      reason: "no-gpu",
      model: null,
      enabled: false,
      ollama: { running: false },
    });
    await expect(engines.localPull()).rejects.toMatchObject({
      messageKey: "engines.local.cannotRun",
    });
    db.close();
  });

  it("asks for Ollama before downloading on a computer that can run a model", async () => {
    const db = openDatabase(":memory:");
    const engines = engineHandlers(db, () => undefined, {
      hardware: async () => gpu16,
    });
    expect(await engines.local()).toMatchObject({
      reason: null,
      model: { id: "gemma3:12b", name: "Gemma 3 12B" },
      ollama: { running: false },
      installUrl: "https://ollama.com/download",
    });
    await expect(engines.localPull()).rejects.toMatchObject({
      messageKey: "engines.local.ollamaMissing",
    });
    db.close();
  });

  it("downloads, checks and turns the model on, then hands it tasks; off hands them back", async () => {
    server = await startFakeOllama({
      pull: { bytes: 8 * GB, steps: 3 },
      replies: [
        {
          text: Array.from({ length: 80 }, () => "word").join(" "),
          tokens: 80,
        },
        { text: valid },
      ],
    });
    process.env.OLLAMA_HOST = server.url;
    const db = openDatabase(":memory:");
    const events: LocalEvent[] = [];
    const engines = engineHandlers(db, () => undefined, {
      hardware: async () => gpu16,
      onLocal: (event) => events.push(event),
    });
    const check = await engines.localPull();
    expect(check.passed).toBe(true);
    expect(events.map((event) => event.phase)).toEqual(
      expect.arrayContaining(["pull", "check", "done"]),
    );
    expect(events.find((event) => event.total)?.total).toBe(8.1 * GB);
    const state = await engines.local();
    expect(state).toMatchObject({
      enabled: true,
      downloaded: true,
      task: null,
    });

    // With no CLI or key, the local model takes every task.
    await configure(db);
    expect(selectionFor(db, "plan")).toMatchObject({
      provider: "ollama",
      model: "gemma3:12b",
    });
    // Pinning it is allowed for the checked model only.
    engines.setFeature({
      feature: "chat",
      provider: "ollama",
      model: "gemma3:12b",
    });
    expect(() =>
      engines.setFeature({
        feature: "chat",
        provider: "ollama",
        model: "llama3:70b",
      }),
    ).toThrow();

    engines.localEnable({ enabled: false });
    expect(engines.features()).toEqual({});
    expect(() => selectionFor(db, "chat")).toThrow();
    expect(() =>
      engines.setFeature({
        feature: "lesson",
        provider: "ollama",
        model: "gemma3:12b",
      }),
    ).toThrow();
    engines.localEnable({ enabled: true });
    await configure(db);
    expect(selectionFor(db, "chat").provider).toBe("ollama");
    db.close();
  });

  it("leaves the option off when the check fails, and never lets the model build plans or grade", async () => {
    server = await startFakeOllama({
      models: ["gemma3:12b"],
      replies: [
        {
          text: Array.from({ length: 80 }, () => "word").join(" "),
          tokens: 80,
        },
        { text: "not json" },
      ],
    });
    process.env.OLLAMA_HOST = server.url;
    const db = openDatabase(":memory:");
    const engines = engineHandlers(db, () => undefined, {
      hardware: async () => gpu16,
    });
    const check = await engines.localPull();
    expect(check).toMatchObject({ passed: false, failure: "structured" });
    expect((await engines.local()).enabled).toBe(false);
    expect(() => engines.localEnable({ enabled: true })).toThrow();
    await configure(db);
    expect(engines.features()).toEqual({});
    // Even with an old setting that claims it is on, plans and grading stay closed to an unstructured model.
    writeLocal(db, {
      ...readLocal(db)!,
      enabled: true,
      check: { ...check, passed: true },
    });
    expect(() =>
      engines.setFeature({
        feature: "plan",
        provider: "ollama",
        model: "gemma3:12b",
      }),
    ).toThrow();
    await configure(db);
    expect(engines.features().plan).toBeUndefined();
    expect(engines.features().grading).toBeUndefined();
    expect(engines.features().chat?.provider).toBe("ollama");
    db.close();
  });

  it("reports a cancelled download and keeps the option off", async () => {
    server = await startFakeOllama({
      pull: { bytes: 8 * GB, steps: 200, delayMs: 20 },
    });
    process.env.OLLAMA_HOST = server.url;
    const db = openDatabase(":memory:");
    const engines = engineHandlers(db, () => undefined, {
      hardware: async () => gpu16,
      onLocal: (event) => {
        if (event.phase === "pull" && (event.completed ?? 0) > GB)
          engines.localCancel();
      },
    });
    await expect(engines.localPull()).rejects.toMatchObject({
      messageKey: "engines.local.cancelled",
    });
    expect(await engines.local()).toMatchObject({
      enabled: false,
      task: null,
      last: { outcome: "cancelled" },
    });
    db.close();
  });
});
