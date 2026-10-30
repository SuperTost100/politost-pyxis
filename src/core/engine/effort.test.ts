import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { forgetModels, rememberModels } from "./efforts";
import { generate } from "./generate";
import { engineHandlers } from "./handlers";
import { planAuto, type AutoProvider } from "./auto";
import { selectionFor } from "./selection";
import { getFunnel, type ProviderId } from "./funnel";
vi.mock("./funnel", async (original) => {
  const actual = await original<typeof import("./funnel")>();
  return { ...actual, getFunnel: vi.fn(actual.getFunnel), runTurn: vi.fn() };
});

const levels = (...ids: string[]) => ids.map((id) => ({ id, label: id }));
const tasks = [
  "chat",
  "map",
  "cards",
  "lesson",
  "vision",
  "default",
  "plan",
  "grading",
] as const;

function pin(
  handlers: ReturnType<typeof engineHandlers>,
  provider: ProviderId,
  model: string,
  feature: (typeof tasks)[number] = "default",
) {
  handlers.setFeature({ feature, provider, model });
}

beforeEach(() => forgetModels());

describe("effort by task", () => {
  it("gives a model the student picked the level of each task", () => {
    rememberModels("claude", [
      {
        id: "claude-sonnet-5",
        efforts: levels("low", "medium", "high", "max"),
      },
    ]);
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    for (const feature of tasks)
      pin(handlers, "claude", "claude-sonnet-5", feature);
    expect(
      Object.fromEntries(tasks.map((f) => [f, selectionFor(db, f).effort])),
    ).toEqual({
      chat: "low",
      map: "low",
      cards: "low",
      lesson: "medium",
      vision: "medium",
      default: "medium",
      plan: "high",
      grading: "medium",
    });
    db.close();
  });

  it("gives a task that borrows the default engine its own level", () => {
    rememberModels("claude", [
      { id: "m", efforts: levels("low", "medium", "high") },
    ]);
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(
      JSON.stringify({
        provider: "claude",
        model: "m",
        effort: "medium",
        auto: true,
      }),
    );
    expect(selectionFor(db, "plan").effort).toBe("high");
    expect(selectionFor(db, "chat").effort).toBe("low");
    db.close();
  });

  it("starts rows saved before efforts existed, without a migration", () => {
    rememberModels("codex", [
      { id: "gpt-6-sol", efforts: levels("low", "high") },
    ]);
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('plan', ?, 1)",
    ).run(JSON.stringify({ provider: "codex", model: "gpt-6-sol" }));
    expect(selectionFor(db, "plan")).toEqual({
      provider: "codex",
      model: "gpt-6-sol",
      effort: "high",
    });
    db.close();
  });

  it("falls back to the nearest level the model lists, per provider", () => {
    rememberModels("antigravity", [
      { id: "gemini-3.1-pro", efforts: levels("low", "high") },
    ]);
    rememberModels("agent", [
      { id: "claude-4.6-sonnet", efforts: levels("medium") },
      { id: "claude-4.6-opus", efforts: levels("high", "max") },
      { id: "composer-2.5", efforts: [] },
    ]);
    rememberModels("claude", [
      { id: "claude-haiku-4-5-20251001", efforts: [] },
    ]);
    const db = openDatabase(":memory:");
    const at = (provider: string, model: string, feature: string) => {
      db.prepare(
        `INSERT OR REPLACE INTO feature_engines (feature, selection_json, updated_at) VALUES (?, ?, 1)`,
      ).run(feature, JSON.stringify({ provider, model }));
      return selectionFor(db, feature).effort;
    };
    // Medium is not listed: low is the next one down.
    expect(at("antigravity", "gemini-3.1-pro", "lesson")).toBe("low");
    expect(at("antigravity", "gemini-3.1-pro", "plan")).toBe("high");
    // Low is not listed: medium is the only way up.
    expect(at("agent", "claude-4.6-sonnet", "chat")).toBe("medium");
    expect(at("agent", "claude-4.6-sonnet", "plan")).toBe("medium");
    expect(at("agent", "claude-4.6-opus", "chat")).toBe("high");
    expect(at("agent", "claude-4.6-opus", "plan")).toBe("high");
    // A model that lists no efforts runs without one.
    expect(at("agent", "composer-2.5", "plan")).toBeUndefined();
    expect(at("claude", "claude-haiku-4-5-20251001", "chat")).toBeUndefined();
    db.close();
  });

  it("sends an automatic row only its own level while the model list is unread", () => {
    const db = openDatabase(":memory:");
    const save = (feature: string, value: object) =>
      db
        .prepare(
          "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES (?, ?, 1)",
        )
        .run(
          feature,
          JSON.stringify({ provider: "claude", model: "m", ...value }),
        );
    save("plan", { effort: "high", effortChoice: "max", auto: true });
    save("grading", { effort: "max" });
    save("chat", { auto: true, effortChoice: "max" });
    // Pyxis's level, not the pick the model may not list.
    expect(selectionFor(db, "plan").effort).toBe("high");
    // A pinned row keeps what it stored.
    expect(selectionFor(db, "grading").effort).toBe("max");
    // An automatic row that borrows no level sends none.
    expect(selectionFor(db, "chat").effort).toBeUndefined();
    // Once the list is read the pick applies again.
    rememberModels("claude", [
      { id: "m", efforts: levels("low", "high", "max") },
    ]);
    expect(selectionFor(db, "plan").effort).toBe("max");
    db.close();
  });

  it("gives API providers the task's effort like the CLIs", () => {
    rememberModels("openai-api", [
      { id: "gpt-test", efforts: levels("low", "medium", "high") },
    ]);
    rememberModels("anthropic-api", [
      { id: "claude-test", efforts: levels("low", "medium", "high", "max") },
    ]);
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    pin(handlers, "openai-api", "gpt-test", "plan");
    pin(handlers, "anthropic-api", "claude-test", "chat");
    expect(selectionFor(db, "plan")).toEqual({
      provider: "openai-api",
      model: "gpt-test",
      effort: "high",
    });
    expect(selectionFor(db, "chat")).toEqual({
      provider: "anthropic-api",
      model: "claude-test",
      effort: "low",
    });
    // A model that lists no effort still runs without one.
    rememberModels("openai-api", [{ id: "gpt-test", efforts: [] }]);
    expect(selectionFor(db, "plan")).toEqual({
      provider: "openai-api",
      model: "gpt-test",
    });
    db.close();
  });

  it("leaves a row alone while the model's list has not been read", () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    pin(handlers, "claude", "unlisted", "plan");
    expect(selectionFor(db, "plan")).toEqual({
      provider: "claude",
      model: "unlisted",
    });
    db.close();
  });

  it("hands the effort to the model call", async () => {
    rememberModels("claude", [
      { id: "claude-opus-5-5", efforts: levels("low", "medium", "high") },
    ]);
    const db = openDatabase(":memory:");
    pin(
      engineHandlers(db, () => undefined),
      "claude",
      "claude-opus-5-5",
      "plan",
    );
    const run = vi.fn().mockResolvedValue({
      text: "ok",
      model: "claude-opus-5-5",
      provider: "claude",
      inputTokens: 1,
    });
    await generate({ prompt: "p", selection: selectionFor(db, "plan"), run });
    expect(run.mock.calls[0]?.[0].selection).toMatchObject({
      provider: "claude",
      model: "claude-opus-5-5",
      effort: "high",
    });
    db.close();
  });
});

describe("the student's own effort", () => {
  function setup() {
    rememberModels("claude", [
      { id: "big", efforts: levels("low", "medium", "high", "max") },
      { id: "small", efforts: levels("low", "medium") },
      { id: "plain", efforts: [] },
    ]);
    const db = openDatabase(":memory:");
    return { db, handlers: engineHandlers(db, () => undefined) };
  }

  it("is stored for a pinned task and used", () => {
    const { db, handlers } = setup();
    pin(handlers, "claude", "big", "chat");
    handlers.setEffort({ feature: "chat", effort: "max" });
    expect(selectionFor(db, "chat").effort).toBe("max");
    handlers.setEffort({ feature: "chat" });
    expect(selectionFor(db, "chat").effort).toBe("low");
    db.close();
  });

  it("is kept beside the effort Pyxis works out for a task Pyxis chose", () => {
    const { db, handlers } = setup();
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('plan', ?, 1)",
    ).run(
      JSON.stringify({
        provider: "claude",
        model: "big",
        effort: "high",
        auto: true,
      }),
    );
    handlers.setEffort({ feature: "plan", effort: "max" });
    expect(handlers.features().plan).toEqual({
      provider: "claude",
      model: "big",
      effort: "max",
      auto: true,
      effortChoice: "max",
    });
    expect(selectionFor(db, "plan")).toEqual({
      provider: "claude",
      model: "big",
      effort: "max",
      chosenFor: "plan",
    });
    handlers.setEffort({ feature: "plan" });
    expect(handlers.features().plan).toEqual({
      provider: "claude",
      model: "big",
      effort: "high",
      auto: true,
    });
    db.close();
  });

  it("falls back to the task's level when the model changes to one that lacks it, and returns with the model", () => {
    const { db, handlers } = setup();
    pin(handlers, "claude", "big", "plan");
    handlers.setEffort({ feature: "plan", effort: "max" });
    // The panel passes the pick along when it changes the model.
    handlers.setFeature({
      feature: "plan",
      provider: "claude",
      model: "small",
      effort: "max",
    });
    expect(selectionFor(db, "plan")).toEqual({
      provider: "claude",
      model: "small",
      effort: "medium",
    });
    handlers.setFeature({
      feature: "plan",
      provider: "claude",
      model: "plain",
      effort: "max",
    });
    expect(selectionFor(db, "plan").effort).toBeUndefined();
    handlers.setFeature({
      feature: "plan",
      provider: "claude",
      model: "big",
      effort: "max",
    });
    expect(selectionFor(db, "plan").effort).toBe("max");
    db.close();
  });

  it("refuses a level the model does not list, on a CLI or an API provider", () => {
    const { db, handlers } = setup();
    pin(handlers, "claude", "small", "chat");
    expect(() =>
      handlers.setEffort({ feature: "chat", effort: "max" }),
    ).toThrow();
    rememberModels("openai-api", [
      { id: "gpt-test", efforts: levels("low", "medium", "high") },
    ]);
    pin(handlers, "openai-api", "gpt-test", "map");
    expect(() =>
      handlers.setEffort({ feature: "map", effort: "max" }),
    ).toThrow();
    handlers.setEffort({ feature: "map", effort: "high" });
    expect(selectionFor(db, "map").effort).toBe("high");
    expect(() =>
      handlers.setEffort({ feature: "vision", effort: "low" }),
    ).toThrow();
    db.close();
  });
});

describe("automatic choice and effort", () => {
  const provider = (
    id: string,
    models: Array<[string, string[]]>,
  ): AutoProvider => ({
    id,
    kind: id.endsWith("-api") ? "api" : "cli",
    effort: true,
    models: models.map(([model, efforts]) => ({
      id: model,
      efforts: levels(...efforts),
    })),
  });

  it("uses the nearest level a chosen model lists", () => {
    const plan = planAuto([
      provider("antigravity", [
        ["gemini-3.8-flash", ["low", "medium", "high"]],
        ["gemini-3.1-pro", ["low", "high"]],
      ]),
    ]);
    expect(plan.chat).toMatchObject({
      model: "gemini-3.8-flash",
      effort: "low",
    });
    expect(plan.lesson).toMatchObject({
      model: "gemini-3.1-pro",
      effort: "low",
    });
    expect(plan.plan).toMatchObject({
      model: "gemini-3.1-pro",
      effort: "high",
    });
  });

  it("gives API providers the tier's level too", () => {
    const plan = planAuto([
      provider("openai-api", [["gpt-6-sol", ["low", "medium", "high"]]]),
    ]);
    expect(plan.plan).toEqual({
      provider: "openai-api",
      model: "gpt-6-sol",
      effort: "high",
    });
  });
});

describe("engines.test effort", () => {
  it("sends the nearest level the model lists, or none when it lists none", async () => {
    const { runTurn } = await import("./funnel");
    vi.mocked(runTurn).mockResolvedValue({
      text: "ok",
      model: "m",
      provider: "claude",
      inputTokens: 1,
    });
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    const sent = async () =>
      vi.mocked(runTurn).mock.calls.at(-1)![0].selection.effort;
    rememberModels("claude", [{ id: "m", efforts: levels("low", "medium") }]);
    await handlers.test({ provider: "claude", model: "m", effort: "max" });
    expect(await sent()).toBe("medium");
    await handlers.test({ provider: "claude", model: "m", effort: "low" });
    expect(await sent()).toBe("low");
    rememberModels("claude", [{ id: "m", efforts: [] }]);
    await handlers.test({ provider: "claude", model: "m", effort: "high" });
    expect(await sent()).toBeUndefined();
    // A model whose list has not been read gets the level as asked.
    forgetModels();
    await handlers.test({ provider: "claude", model: "m", effort: "high" });
    expect(await sent()).toBe("high");
    db.close();
  });
});

describe("automatic choice keeps the student's effort", () => {
  const listing = {
    providers: {
      claude: { capabilities: { effort: true, fast: false, access: ["none"] } },
    },
    overview: async () => [
      {
        id: "claude",
        displayName: "Claude Code",
        installation: { installed: true },
        auth: { loggedIn: true },
        capabilities: { effort: true, fast: false, access: ["none"] },
      },
    ],
    models: async () => [
      {
        id: "claude-opus-5-5",
        name: "o",
        efforts: levels("low", "medium", "high", "max"),
      },
      {
        id: "claude-sonnet-5",
        name: "s",
        efforts: levels("low", "medium", "high", "max"),
      },
      { id: "claude-haiku-4-5", name: "h", efforts: levels("low") },
    ],
  } as unknown as ReturnType<typeof getFunnel>;

  it("carries it across model changes and a reset of one task, not a reset of all", async () => {
    vi.mocked(getFunnel).mockImplementation(() => listing);
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    await handlers.autoConfigure({});
    expect(handlers.features().chat).toMatchObject({
      model: "claude-haiku-4-5",
      effort: "low",
      auto: true,
    });
    handlers.setEffort({ feature: "chat", effort: "low" });
    handlers.setEffort({ feature: "plan", effort: "max" });
    await handlers.autoConfigure({});
    expect(handlers.features().plan).toMatchObject({
      effort: "max",
      effortChoice: "max",
    });
    // Pin the plan to a model without the pick, hand the task back to Pyxis: the pick comes back with Opus.
    handlers.setFeature({
      feature: "plan",
      provider: "claude",
      model: "claude-haiku-4-5",
      effort: "max",
    });
    expect(selectionFor(db, "plan").effort).toBe("low");
    await handlers.autoConfigure({ reset: true, features: ["plan"] });
    expect(handlers.features().plan).toMatchObject({
      model: "claude-opus-5-5",
      effort: "max",
      effortChoice: "max",
      auto: true,
    });
    await handlers.autoConfigure({ reset: true });
    expect(handlers.features().plan?.effortChoice).toBeUndefined();
    expect(handlers.features().plan?.effort).toBe("high");
    db.close();
  });
});
