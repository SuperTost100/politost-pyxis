import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { engineHandlers } from "./handlers";
import { selectionFor } from "./selection";
import { getFunnel } from "./funnel";
vi.mock("./funnel", async (original) => {
  const actual = await original<typeof import("./funnel")>();
  return { ...actual, getFunnel: vi.fn(actual.getFunnel), runTurn: vi.fn() };
});

const efforts = ["low", "medium", "high"].map((id) => ({ id, label: id }));
type State = { claude: boolean; codex: boolean };

function fakeFunnel(state: State, listing: "ok" | "offline" = "ok") {
  const row = (id: string, displayName: string, loggedIn: boolean) => ({
    id,
    displayName,
    installation: { installed: true },
    auth: { loggedIn },
    capabilities: { effort: true, fast: false },
  });
  const models = {
    claude: ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"],
    codex: ["gpt-6-sol", "gpt-5.6-terra", "gpt-6-luna"],
  };
  return {
    overview: async () => [
      row("claude", "Claude Code", state.claude),
      row("codex", "Codex", state.codex),
      row("agent", "Cursor Agent", true),
    ],
    models: async (id: "claude" | "codex") => {
      if (listing === "offline") throw new Error("offline");
      return models[id].map((model) => ({ id: model, name: model, efforts }));
    },
  } as unknown as ReturnType<typeof getFunnel>;
}

async function withFunnel<T>(
  state: State,
  run: () => Promise<T>,
  listing: "ok" | "offline" = "ok",
): Promise<T> {
  const original = vi.mocked(getFunnel).getMockImplementation();
  vi.mocked(getFunnel).mockImplementation(() => fakeFunnel(state, listing));
  try {
    return await run();
  } finally {
    if (original) vi.mocked(getFunnel).mockImplementation(original);
  }
}

describe("automatic engine choice", () => {
  it("chooses engines for every feature, marks them automatic and hides the flag from callers", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    const result = await withFunnel({ claude: true, codex: true }, () =>
      handlers.autoConfigure({}),
    );
    // Cursor Agent is disabled, so it is never counted as ready.
    expect(result.ready).toEqual(["claude", "codex"]);
    expect(Object.keys(result.features).sort()).toEqual(
      ["chat", "default", "grading", "lesson", "map", "plan", "vision"].sort(),
    );
    expect(result.features.chat).toEqual({
      provider: "codex",
      model: "gpt-6-luna",
      effort: "low",
      auto: true,
    });
    expect(result.features.plan).toMatchObject({
      provider: "claude",
      model: "claude-opus-5-5",
      effort: "high",
    });
    expect(selectionFor(db, "chat")).toEqual({
      provider: "codex",
      model: "gpt-6-luna",
      effort: "low",
    });
    db.close();
  });

  it("keeps pinned features, rewrites automatic ones and returns to automatic on reset", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    await withFunnel({ claude: true, codex: true }, () =>
      handlers.autoConfigure({}),
    );
    handlers.setFeature({
      feature: "chat",
      provider: "claude",
      model: "claude-sonnet-5",
    });
    expect(handlers.features().chat?.auto).toBeUndefined();
    // Codex signs out: automatic features move to Claude Code, the pinned chat stays.
    const moved = await withFunnel({ claude: true, codex: false }, () =>
      handlers.autoConfigure({}),
    );
    expect(moved.ready).toEqual(["claude"]);
    expect(moved.features.chat).toEqual({
      provider: "claude",
      model: "claude-sonnet-5",
    });
    expect(moved.features.map).toMatchObject({
      provider: "claude",
      model: "claude-haiku-4-5",
      auto: true,
    });
    const reset = await withFunnel({ claude: true, codex: true }, () =>
      handlers.autoConfigure({ reset: true, features: ["chat"] }),
    );
    expect(reset.features.chat).toMatchObject({
      provider: "codex",
      auto: true,
    });
    db.close();
  });

  it("drops automatic choices when nothing is ready but keeps pinned ones", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    await withFunnel({ claude: true, codex: false }, () =>
      handlers.autoConfigure({}),
    );
    handlers.setFeature({ feature: "plan", provider: "codex", model: "gpt-x" });
    const none = await withFunnel({ claude: false, codex: false }, () =>
      handlers.autoConfigure({}),
    );
    expect(none.ready).toEqual([]);
    expect(Object.keys(none.features)).toEqual(["plan"]);
    expect(() => selectionFor(db, "chat")).toThrow();
    db.close();
  });

  it("clears every pin when asked to reset without a feature list", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    handlers.setFeature({ feature: "plan", provider: "codex", model: "gpt-x" });
    const result = await withFunnel({ claude: true, codex: false }, () =>
      handlers.autoConfigure({ reset: true }),
    );
    expect(result.features.plan).toMatchObject({
      provider: "claude",
      auto: true,
    });
    db.close();
  });

  it("keeps the current choices when a ready engine cannot list its models", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    await withFunnel({ claude: true, codex: false }, () =>
      handlers.autoConfigure({}),
    );
    const before = handlers.features();
    await withFunnel(
      { claude: true, codex: false },
      () => handlers.autoConfigure({}),
      "offline",
    );
    expect(handlers.features()).toEqual(before);
    db.close();
  });

  it("recomputes in the background when the engine set changes", async () => {
    const db = openDatabase(":memory:");
    let notified = 0;
    const handlers = engineHandlers(db, () => undefined, {
      auto: true,
      onAuto: () => {
        notified += 1;
      },
    });
    await withFunnel({ claude: true, codex: false }, async () => {
      await handlers.overview();
      await vi.waitFor(() =>
        expect(handlers.features().chat).toMatchObject({
          provider: "claude",
          auto: true,
        }),
      );
      // An open engines screen hears about it, so it never shows the old choices.
      await vi.waitFor(() => expect(notified).toBe(1));
      await handlers.autoConfigure({});
      await vi.waitFor(() => expect(notified).toBe(2));
    });
    db.close();
  });
});
