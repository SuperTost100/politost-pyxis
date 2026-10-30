import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import {
  clearBench,
  configureSignOuts,
  isBenched,
  isSignedOut,
  markSignedOut,
} from "./bench";
import { signOutStore } from "./choice";
import { generate } from "./generate";
import type { AutoProvider } from "./auto";
import { getFunnel, runTurn } from "./funnel";
import { autoConfigureEngines, engineHandlers } from "./handlers";
import { fallbackSelection, rememberReady, selectionFor } from "./selection";
vi.mock("./funnel", async (original) => {
  const actual = await original<typeof import("./funnel")>();
  return { ...actual, getFunnel: vi.fn(actual.getFunnel), runTurn: vi.fn() };
});

const efforts = ["low", "medium", "high"].map((id) => ({ id, label: id }));
type State = { claude: boolean; codex: boolean };
const models = {
  claude: ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"],
  codex: ["gpt-6-sol", "gpt-5.6-terra", "gpt-6-luna"],
};

/** Two CLIs whose own sign-in check reports `state`, as Codex keeps doing after its token stopped working. */
function useFunnel(state: State) {
  const provider = {
    capabilities: { access: ["none"], effort: true, fast: false },
  };
  vi.mocked(getFunnel).mockImplementation(
    () =>
      ({
        providers: { claude: provider, codex: provider },
        overview: async () =>
          (["claude", "codex"] as const).map((id) => ({
            id,
            displayName: id === "claude" ? "Claude Code" : "Codex",
            installation: { installed: true, version: "1.0.0" },
            auth: { loggedIn: state[id] },
            capabilities: provider.capabilities,
          })),
        models: async (id: "claude" | "codex") =>
          models[id].map((model) => ({ id: model, name: model, efforts })),
      }) as unknown as ReturnType<typeof getFunnel>,
  );
}

/** What Codex prints when its saved sign-in no longer works: every call comes back 401. */
const refused = () =>
  Object.assign(
    new Error(
      'codex exited (1) without a result. unexpected status 401 Unauthorized: {"detail":"token expired"}',
    ),
    { code: "cli-failed" },
  );

const providersIn = (features: Record<string, { provider: string }>) =>
  [...new Set(Object.values(features).map((row) => row.provider))].sort();

afterEach(() => {
  clearBench();
  vi.mocked(runTurn).mockReset();
});

describe("an engine whose sign-in was refused", () => {
  it("reads signed out and leaves the automatic plan, though its CLI still says signed in", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    useFunnel({ claude: true, codex: true });
    await handlers.autoConfigure({});
    expect(providersIn(handlers.features())).toEqual(["claude", "codex"]);

    vi.mocked(runTurn).mockRejectedValueOnce(refused());
    await expect(handlers.test({ provider: "codex" })).rejects.toMatchObject({
      code: "not-logged-in",
    });

    const codex = (await handlers.overview()).find((row) => row.id === "codex");
    expect(codex).toMatchObject({ loggedIn: false, refused: true });
    // A second scan still hears "signed in" from the CLI. That is not a new sign-in.
    const again = (await handlers.overview()).find((row) => row.id === "codex");
    expect(again).toMatchObject({ loggedIn: false, refused: true });
    const result = await handlers.autoConfigure({});
    expect(result.ready).toEqual(["claude"]);
    expect(providersIn(result.features)).toEqual(["claude"]);
    db.close();
  });

  it("comes back after a scan sees it signed out and then signed in", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    const state = { claude: true, codex: true };
    useFunnel(state);
    markSignedOut("codex");
    await handlers.overview();
    state.codex = false;
    await handlers.overview();
    state.codex = true;
    const codex = (await handlers.overview()).find((row) => row.id === "codex");
    expect(codex).toMatchObject({ loggedIn: true, refused: false });
    expect(isBenched("codex")).toBe(false);
    db.close();
  });

  it("stays out when the only signed-out scan came before the refusal", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    const state = { claude: true, codex: false };
    useFunnel(state);
    await handlers.overview();
    // The student signs in in a terminal, then a call is refused before any scan sees the sign-in.
    state.codex = true;
    markSignedOut("codex");
    const codex = (await handlers.overview()).find((row) => row.id === "codex");
    expect(codex).toMatchObject({ loggedIn: false, refused: true });
    // A sign-out seen after the refusal, then a sign-in, brings it back.
    state.codex = false;
    await handlers.overview();
    state.codex = true;
    const back = (await handlers.overview()).find((row) => row.id === "codex");
    expect(back).toMatchObject({ loggedIn: true, refused: false });
    db.close();
  });

  it("keeps a refusal that lands while a test of the same engine is answering", async () => {
    const db = openDatabase(":memory:");
    useFunnel({ claude: true, codex: true });
    vi.mocked(runTurn).mockImplementationOnce(async () => {
      // Another call to Codex is refused while this test waits for its answer.
      markSignedOut("codex");
      return { text: "ok", model: "gpt-6-luna", provider: "codex", inputTokens: 2 };
    });
    await engineHandlers(db, () => undefined).test({ provider: "codex" });
    expect(isSignedOut("codex")).toBe(true);
    db.close();
  });

  it("keeps a refusal that lands while another call to the same engine is answering", async () => {
    await generate({
      selection: { provider: "codex", model: "gpt-6-luna" },
      prompt: "hi",
      run: async () => {
        markSignedOut("codex");
        return { text: "ok", model: "gpt-6-luna", provider: "codex", inputTokens: 2 };
      },
    });
    expect(isSignedOut("codex")).toBe(true);
  });

  it("leaves out an engine refused while the plan was reading model lists", async () => {
    const db = openDatabase(":memory:");
    useFunnel({ claude: true, codex: true });
    const funnel = getFunnel();
    vi.mocked(getFunnel).mockImplementation(
      () =>
        ({
          ...funnel,
          models: async (id: "claude" | "codex") => {
            if (id === "codex") markSignedOut("codex");
            return funnel.models(id);
          },
        }) as unknown as ReturnType<typeof getFunnel>,
    );
    const result = await autoConfigureEngines(db);
    expect(providersIn(result.features)).toEqual(["claude"]);
    db.close();
  });

  it("comes back after a test that answers", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    useFunnel({ claude: true, codex: true });
    markSignedOut("codex");
    vi.mocked(runTurn).mockResolvedValueOnce({
      text: "ok",
      model: "gpt-6-luna",
      provider: "codex",
      inputTokens: 2,
    });
    await handlers.test({ provider: "codex" });
    expect(isSignedOut("codex")).toBe(false);
    const result = await handlers.autoConfigure({});
    expect(providersIn(result.features)).toEqual(["claude", "codex"]);
    db.close();
  });

  it("is marked by any refused call, even a pinned one with no engine to fall back on", async () => {
    await expect(
      generate({
        selection: { provider: "codex", model: "gpt-6-luna" },
        prompt: "hi",
        run: async () => {
          throw refused();
        },
      }),
    ).rejects.toMatchObject({ code: "not-logged-in" });
    expect(isSignedOut("codex")).toBe(true);
  });

  it("stays marked after a restart until it is signed in again", () => {
    const db = openDatabase(":memory:");
    configureSignOuts(signOutStore(db));
    markSignedOut("codex");
    clearBench();
    expect(isSignedOut("codex")).toBe(false);
    configureSignOuts(signOutStore(db));
    expect(isSignedOut("codex")).toBe(true);
    db.close();
  });
});

describe("the engines the student lets Pyxis use", () => {
  it("starts automatic, keeps the student's choice and plans only with those engines", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    useFunnel({ claude: true, codex: true });
    expect(handlers.choice()).toEqual({ allowed: null });

    handlers.choose({ allowed: ["claude"] });
    // A new launch reads the same choice.
    expect(engineHandlers(db, () => undefined).choice()).toEqual({
      allowed: ["claude"],
    });
    const overview = await handlers.overview();
    expect(
      overview.map((row) => [row.id, row.allowed]),
    ).toEqual([
      ["claude", true],
      ["codex", false],
    ]);
    const result = await handlers.autoConfigure({});
    expect(result.ready).toEqual(["claude"]);
    expect(providersIn(result.features)).toEqual(["claude"]);

    handlers.choose({ allowed: null });
    expect(providersIn((await handlers.autoConfigure({})).features)).toEqual([
      "claude",
      "codex",
    ]);
    db.close();
  });

  it("plans with no engine the student allowed that is not ready", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    useFunnel({ claude: true, codex: true });
    handlers.choose({ allowed: ["codex"] });
    markSignedOut("codex");
    const result = await handlers.autoConfigure({});
    expect(result.ready).toEqual([]);
    expect(result.features).toEqual({});
    db.close();
  });

  it("drops tasks pinned to an engine the student left out, and refuses new ones", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    useFunnel({ claude: true, codex: true });
    handlers.setFeature({ feature: "chat", provider: "codex", model: "gpt-6-luna" });
    handlers.choose({ allowed: ["claude"] });
    expect(handlers.features().chat).toBeUndefined();
    expect(() =>
      handlers.setFeature({ feature: "chat", provider: "codex", model: "gpt-6-luna" }),
    ).toThrow();
    // A test still works on any engine, but a passing one does not make a left-out engine the default.
    vi.mocked(runTurn).mockResolvedValueOnce({
      text: "ok",
      model: "gpt-6-luna",
      provider: "codex",
      inputTokens: 2,
    });
    await handlers.test({ provider: "codex" });
    expect(handlers.features().default).toBeUndefined();
    db.close();
  });

  it("stops a fallback to a left-out engine at once, before the plan is worked out again", () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    useFunnel({ claude: true, codex: true });
    const engine = (id: string, model: string): AutoProvider => ({
      id,
      kind: "cli",
      effort: true,
      models: [{ id: model, efforts }],
    });
    rememberReady([
      engine("claude", "claude-sonnet-5"),
      engine("codex", "gpt-6-luna"),
    ]);
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('chat', ?, 1)",
    ).run(
      JSON.stringify({ provider: "claude", model: "claude-sonnet-5", auto: true }),
    );
    const chat = selectionFor(db, "chat");
    handlers.choose({ allowed: ["claude"] });
    expect(fallbackSelection(chat, "limit")).toBeUndefined();
    rememberReady([]);
    db.close();
  });

  it("leaves out an engine the student excluded while its models were being read", async () => {
    const db = openDatabase(":memory:");
    const handlers = engineHandlers(db, () => undefined);
    useFunnel({ claude: true, codex: true });
    const funnel = getFunnel();
    vi.mocked(getFunnel).mockImplementation(
      () =>
        ({
          ...funnel,
          models: async (id: "claude" | "codex") => {
            // The student narrows the choice while this plan is still reading model lists.
            if (id === "codex") handlers.choose({ allowed: ["claude"] });
            return funnel.models(id);
          },
        }) as unknown as ReturnType<typeof getFunnel>,
    );
    const result = await autoConfigureEngines(db);
    expect(providersIn(result.features)).toEqual(["claude"]);
    db.close();
  });

  it("refuses an empty choice", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      engineHandlers(db, () => undefined).choose({ allowed: [] }),
    ).toThrow();
    db.close();
  });
});

describe("the engine test", () => {
  it("asks the cheapest model at its lowest effort, with a one-line system prompt in place of the CLI's own", async () => {
    const db = openDatabase(":memory:");
    useFunnel({ claude: true, codex: true });
    vi.mocked(runTurn).mockResolvedValueOnce({
      text: "ok",
      model: "claude-haiku-4-5",
      provider: "claude",
      inputTokens: 2,
    });
    await engineHandlers(db, () => undefined).test({ provider: "claude" });
    const call = vi.mocked(runTurn).mock.calls[0]![0];
    expect(call.selection).toMatchObject({
      provider: "claude",
      model: "claude-haiku-4-5",
      effort: "low",
    });
    expect(call.system).toMatch(/^.{1,60}$/);
    expect(call.prompt.length).toBeLessThan(40);
    db.close();
  });

  it("keeps the model and effort the student picked", async () => {
    const db = openDatabase(":memory:");
    useFunnel({ claude: true, codex: true });
    vi.mocked(runTurn).mockResolvedValueOnce({
      text: "ok",
      model: "claude-opus-5-5",
      provider: "claude",
      inputTokens: 2,
    });
    await engineHandlers(db, () => undefined).test({
      provider: "claude",
      model: "claude-opus-5-5",
      effort: "high",
    });
    expect(vi.mocked(runTurn).mock.calls[0]![0].selection).toMatchObject({
      model: "claude-opus-5-5",
      effort: "high",
    });
    db.close();
  });
});
