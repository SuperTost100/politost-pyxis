import { afterEach, describe, expect, it, vi } from "vitest";
import shipped from "../../../resources/model-roles.json";
import { openDatabase } from "../db/connection";
import { planAuto, type AutoProvider } from "./auto";
import { clearBench } from "./bench";
import { forgetModels, modelNames } from "./efforts";
import { getFunnel } from "./funnel";
import { engineHandlers } from "./handlers";
import {
  adoptModelFile,
  automaticEffortOn,
  capabilityOf,
  isForeignModel,
  isOwnModel,
  modelFile,
  modelFileSchema,
  ownModels,
  resetModelFile,
  type ModelFile,
} from "./model-roles";
import { fallbackSelection, rememberReady, selectionFor } from "./selection";

vi.mock("./funnel", async (original) => {
  const actual = await original<typeof import("./funnel")>();
  return { ...actual, getFunnel: vi.fn(actual.getFunnel), runTurn: vi.fn() };
});

const levels = ["low", "medium", "high"].map((id) => ({ id }));
const model = (id: string) => ({ id, efforts: levels });
const copy = (): ModelFile => JSON.parse(JSON.stringify(shipped)) as ModelFile;

/** Everything each tool reports on a signed-in account today, makers mixed the way Antigravity mixes them. */
const reported: Record<string, string[]> = {
  claude: ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  codex: ["gpt-6.2-sol", "gpt-6.1-terra", "gpt-6-luna"],
  antigravity: [
    "gemini-4-argon",
    "gemini-4-hydrogen",
    "gemini-3.8-flash",
    "gemini-pro-orchestrator-neon",
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "gpt-oss-120b-medium",
  ],
};
const makers: Record<string, RegExp> = {
  claude: /^claude-/,
  codex: /^gpt-/,
  antigravity: /^gemini-/,
};

function fakeFunnel() {
  const capabilities = { effort: true, fast: false, access: ["none"] };
  const row = (id: string, displayName: string) => ({
    id,
    displayName,
    installation: { installed: true },
    auth: { loggedIn: true },
    capabilities,
  });
  return {
    overview: async () => Object.keys(reported).map((id) => row(id, id)),
    models: async (id: string) => reported[id]!.map((name) => ({ id: name, name: `name of ${name}`, efforts: levels })),
    providers: Object.fromEntries(Object.keys(reported).map((id) => [id, { capabilities }])),
  } as unknown as ReturnType<typeof getFunnel>;
}

afterEach(() => {
  resetModelFile();
  rememberReady([]);
  clearBench();
  forgetModels();
  vi.mocked(getFunnel).mockReset();
});

describe("the model file", () => {
  it("is valid as shipped, and every role names models", () => {
    expect(modelFileSchema.safeParse(shipped).success).toBe(true);
    expect(Object.keys(shipped.tools).sort()).toEqual(["anthropic-api", "antigravity", "claude", "codex", "openai-api"]);
  });

  it("puts no Fable model in any role", () => {
    for (const rule of Object.values(modelFile().tools))
      for (const role of Object.values(rule.roles)) expect(role.models.join(" ")).not.toMatch(/fable/i);
  });

  it("lists only each maker's own ids in its roles", () => {
    for (const [id, rule] of Object.entries(modelFile().tools))
      for (const role of Object.values(rule.roles)) for (const name of role.models) expect(isOwnModel(id, name)).toBe(true);
  });

  it("states what every model named in a role can do", () => {
    for (const [tool, rule] of Object.entries(modelFile().tools))
      for (const [name, role] of Object.entries(rule.roles))
        for (const id of role.models) {
          const capability = capabilityOf(id);
          expect(capability, `${tool} ${name} ${id}`).not.toBeNull();
          expect(typeof capability!.vision).toBe("boolean");
          expect(typeof capability!.structured).toBe("boolean");
          expect(capability!.contextTokens).toBeGreaterThan(0);
        }
  });

  it("reads the newest models of a tool as able to read images, with no second file to change", () => {
    for (const id of ["gpt-6.1-terra", "gpt-6.2-sol", "gpt-6-luna", "claude-sonnet-5-5", "gemini-4-hydrogen"])
      expect(capabilityOf(id)?.vision, id).toBe(true);
    for (const id of ["gpt-oss-120b", "gpt-audio", "composer-2.5", "text-only-small"]) expect(capabilityOf(id)?.vision ?? false, id).toBe(false);
  });

  it("refuses a file that names a model in a role without saying what it can do, and takes one that says it", () => {
    const withModel = (capabilities: ModelFile["capabilities"]) => {
      const file = copy();
      file.updatedAt = "2099-01-01T00:00:00Z";
      file.tools.codex!.roles.mid.models = ["gpt-7-nova", ...file.tools.codex!.roles.mid.models];
      file.capabilities = capabilities;
      return file;
    };
    expect(adoptModelFile(withModel(copy().capabilities))).toBe(false);
    expect(capabilityOf("gpt-7-nova")).toBeNull();
    const stated = withModel([{ pattern: "^gpt-7-", vision: true, structured: true, contextTokens: 400000 }, ...copy().capabilities]);
    expect(adoptModelFile(stated)).toBe(true);
    expect(capabilityOf("gpt-7-nova")).toMatchObject({ vision: true, contextTokens: 400000 });
    // The photo work then takes it, with no change anywhere else.
    const codex: AutoProvider = { id: "codex", kind: "cli", effort: true, models: [model("gpt-7-nova"), model("gpt-6.1-terra")] };
    expect(planAuto([codex]).vision?.model).toBe("gpt-7-nova");
  });

  it("ignores a file that does not validate", () => {
    const newer = (change: (file: ModelFile) => unknown) => {
      const file = copy();
      file.updatedAt = "2099-01-01T00:00:00Z";
      return change(file) ?? file;
    };
    expect(adoptModelFile(newer((file) => ({ ...file, version: 2 })))).toBe(false);
    expect(adoptModelFile(newer((file) => ({ ...file, updatedAt: "yesterday" })))).toBe(false);
    expect(adoptModelFile(newer((file) => ({ ...file, tools: { claude: { ...file.tools.claude, own: "(" } } })))).toBe(false);
    expect(adoptModelFile(newer((file) => ({ ...file, tools: { claude: { own: "^claude-", roles: {} } } })))).toBe(false);
    expect(adoptModelFile(newer((file) => ({ ...file, tools: { claude: { ...file.tools.claude, roles: { ...file.tools.claude!.roles, fast: { effort: "low", models: [] } } } } })))).toBe(false);
    // A file that leaves a tool out would strand that tool, so it is ignored too.
    expect(adoptModelFile(newer((file) => ({ ...file, tools: {} })))).toBe(false);
    expect(adoptModelFile(newer((file) => ({ ...file, tools: { claude: file.tools.claude } })))).toBe(false);
    expect(adoptModelFile(newer((file) => ({ ...file, capabilities: [{ pattern: "(", vision: true, structured: true, contextTokens: 1 }] })))).toBe(false);
    expect(adoptModelFile(newer((file) => ({ ...file, capabilities: undefined })))).toBe(false);
    expect(adoptModelFile(null)).toBe(false);
    expect(adoptModelFile("model-roles")).toBe(false);
    expect(modelFile().updatedAt).toBe(shipped.updatedAt);
  });

  it("keeps the newest of two valid copies: an older or equal download does not replace the shipped one", () => {
    const older = copy();
    older.updatedAt = "2020-01-01T00:00:00Z";
    older.tools.claude!.roles.fast.models = ["claude-haiku-4-5-20251001"];
    expect(adoptModelFile(older)).toBe(false);
    expect(adoptModelFile(copy())).toBe(false);
    expect(modelFile().tools.claude!.roles.fast.models[0]).toBe("claude-haiku-5-5");
    const newer = copy();
    newer.updatedAt = "2099-01-01T00:00:00Z";
    newer.tools.claude!.roles.fast.models = ["claude-haiku-9"];
    expect(adoptModelFile(newer)).toBe(true);
    expect(modelFile().tools.claude!.roles.fast.models[0]).toBe("claude-haiku-9");
    // Once a newer copy is in use, an older one cannot take its place either.
    expect(adoptModelFile(older)).toBe(false);
    expect(modelFile().tools.claude!.roles.fast.models[0]).toBe("claude-haiku-9");
  });
});

describe("a tool only runs its maker's models", () => {
  it("recognises the maker's ids and another maker's", () => {
    expect(isOwnModel("antigravity", "gpt-oss-120b-medium")).toBe(false);
    expect(isOwnModel("antigravity", "claude-sonnet-5-5")).toBe(false);
    expect(isOwnModel("antigravity", "gemini-3.8-flash")).toBe(true);
    expect(isForeignModel("antigravity", "claude-opus-5-5")).toBe(true);
    expect(isForeignModel("antigravity", "gpt-oss-120b-medium")).toBe(false);
    expect(isForeignModel("claude", "claude-opus-5-5")).toBe(false);
    // The local model has no rule: nothing is ruled out for it.
    expect(isOwnModel("ollama", "gemma3:12b")).toBe(true);
  });

  it("keeps only the maker's models of each tool's own listing", () => {
    for (const [id, names] of Object.entries(reported)) {
      const own = ownModels(id, names.map((name) => ({ id: name }))).map((entry) => entry.id);
      expect(own.length).toBeGreaterThan(0);
      for (const name of own) expect(name).toMatch(makers[id]!);
    }
    expect(ownModels("antigravity", reported.antigravity!.map((name) => ({ id: name }))).map((entry) => entry.id)).toEqual([
      "gemini-4-argon",
      "gemini-4-hydrogen",
      "gemini-3.8-flash",
    ]);
  });

  it("never gives a tool another maker's model in the automatic choice, whatever the tool reports", () => {
    const ready: AutoProvider[] = Object.entries(reported).map(([id, names]) => ({
      id,
      kind: "cli",
      effort: true,
      models: names.map(model),
    }));
    const plan = planAuto(ready);
    expect(Object.keys(plan).length).toBe(8);
    for (const choice of Object.values(plan)) expect(choice.model).toMatch(makers[choice.provider]!);
    // Each tool alone, with the others' models mixed into its list.
    for (const provider of ready)
      for (const choice of Object.values(planAuto([provider]))) expect(choice.model).toMatch(makers[provider.id]!);
  });

  it("never falls back to another maker's model after a refusal, a limit or a missing program", () => {
    const ready: AutoProvider[] = ["claude", "antigravity"].map((id) => ({
      id,
      kind: "cli",
      effort: true,
      images: false,
      models: reported[id]!.map(model),
    }));
    rememberReady(ready);
    for (const reason of ["model", "limit", "signed-out", "not-installed"] as const) {
      for (const provider of ["claude", "antigravity"]) {
        const next = fallbackSelection({ provider, chosenFor: "plan" }, reason);
        if (next) expect(next.model).toMatch(makers[next.provider]!);
      }
    }
  });

  it("follows the file's order, not the order the tool lists its models in", () => {
    const provider: AutoProvider = {
      id: "antigravity",
      kind: "cli",
      effort: true,
      models: ["gemini-4-neon", "gemini-4-hydrogen", "gemini-3.8-flash"].map(model),
    };
    expect(planAuto([provider]).lesson?.model).toBe("gemini-4-hydrogen");
    const reordered = copy();
    reordered.updatedAt = "2099-01-01T00:00:00Z";
    reordered.tools.antigravity!.roles.mid.models = ["gemini-4-neon", "gemini-4-hydrogen"];
    expect(adoptModelFile(reordered)).toBe(true);
    expect(planAuto([provider]).lesson?.model).toBe("gemini-4-neon");
    // A model the new file names first but the account does not report is skipped for the next one.
    const without: AutoProvider = { ...provider, models: [model("gemini-4-hydrogen"), model("gemini-3.8-flash")] };
    expect(planAuto([without]).lesson?.model).toBe("gemini-4-hydrogen");
  });

  describe("a task's role on one tool, as data", () => {
    const claude: AutoProvider = { id: "claude", kind: "cli", effort: true, models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"].map(model) };
    const codex: AutoProvider = { id: "codex", kind: "cli", effort: true, models: ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.2-sol"].map(model) };
    function chatOnMid(...tools: string[]) {
      const file = copy();
      file.updatedAt = "2099-01-01T00:00:00Z";
      for (const tool of tools) file.tools[tool]!.featureRoles = { chat: "mid" };
      expect(adoptModelFile(file)).toBe(true);
    }

    it("keeps every task in the tier model-tiers.json gives it while no tool says otherwise", () => {
      expect(planAuto([claude]).chat).toEqual({ provider: "claude", model: "claude-haiku-5-5", effort: "low" });
      expect(planAuto([codex]).chat).toEqual({ provider: "codex", model: "gpt-6-luna", effort: "low" });
    });

    it("runs the chat on the mid role of the tools that say so and on the fast role of the others", () => {
      chatOnMid("claude");
      expect(planAuto([claude]).chat).toEqual({ provider: "claude", model: "claude-sonnet-5-5", effort: "medium" });
      expect(planAuto([codex]).chat).toEqual({ provider: "codex", model: "gpt-6-luna", effort: "low" });
      // Only the chat moves: maps and flashcards stay fast, and the other tasks are as they were.
      const plan = planAuto([claude]);
      expect(plan.map?.model).toBe("claude-haiku-5-5");
      expect(plan.cards?.model).toBe("claude-haiku-5-5");
      expect(plan.lesson?.model).toBe("claude-sonnet-5-5");
      expect(plan.plan?.model).toBe("claude-opus-5-5");
    });

    it("moves the effort of a task already stored with the role, not only the model", () => {
      chatOnMid("claude", "codex");
      expect(automaticEffortOn("claude", "chat", ["low", "medium", "high"])).toBe("medium");
      expect(automaticEffortOn("codex", "chat", ["low", "medium", "high"])).toBe("medium");
      expect(automaticEffortOn("claude", "map", ["low", "medium", "high"])).toBe("low");
      expect(planAuto([codex]).chat).toEqual({ provider: "codex", model: "gpt-6.1-terra", effort: "medium" });
    });

    it("refuses a role that is not fast, mid or strong", () => {
      const file = copy();
      file.updatedAt = "2099-01-01T00:00:00Z";
      (file.tools.claude as unknown as { featureRoles: unknown }).featureRoles = { chat: "medium" };
      expect(adoptModelFile(file)).toBe(false);
    });
  });

  it("uses the effort the file gives the role, and the nearest level the model lists", () => {
    const file = copy();
    file.updatedAt = "2099-01-01T00:00:00Z";
    file.tools.codex!.roles.fast.effort = "high";
    adoptModelFile(file);
    const provider: AutoProvider = { id: "codex", kind: "cli", effort: true, models: [model("gpt-6-luna")] };
    expect(planAuto([provider]).chat).toEqual({ provider: "codex", model: "gpt-6-luna", effort: "high" });
  });
});

describe("through the engine handlers", () => {
  function setup() {
    vi.mocked(getFunnel).mockImplementation(fakeFunnel);
    const db = openDatabase(":memory:");
    return { db, handlers: engineHandlers(db, () => undefined) };
  }

  it("shows only the maker's models in the list and in the names", async () => {
    const { db, handlers } = setup();
    for (const id of Object.keys(reported)) {
      const list = await handlers.models({ provider: id as never });
      expect(list.length).toBeGreaterThan(0);
      for (const entry of list) expect(entry.id).toMatch(makers[id]!);
      for (const name of Object.keys(modelNames()[id] ?? {})) expect(name).toMatch(makers[id]!);
    }
    await handlers.autoConfigure({});
    for (const [id, names] of Object.entries(modelNames())) for (const name of Object.keys(names)) expect(name).toMatch(makers[id]!);
    db.close();
  });

  it("gives every task a model of its tool's maker, with every tool ready", async () => {
    const { db, handlers } = setup();
    const { features } = await handlers.autoConfigure({});
    expect(Object.keys(features).length).toBe(8);
    for (const row of Object.values(features)) expect(row.model).toMatch(makers[row.provider]!);
    for (const feature of Object.keys(features)) {
      const choice = selectionFor(db, feature);
      expect(choice.model).toMatch(makers[choice.provider]!);
    }
    db.close();
  });

  it("refuses to pin another maker's model", async () => {
    const { db, handlers } = setup();
    await handlers.autoConfigure({});
    const pin = (provider: string, model: string) => () =>
      handlers.setFeature({ feature: "chat", provider: provider as never, model });
    // Antigravity reported GPT-OSS in the listing above, so it is known as not Gemini's own to run.
    for (const [provider, name] of [
      ["antigravity", "gpt-oss-120b-medium"],
      ["antigravity", "claude-sonnet-5-5"],
      ["codex", "gemini-3.8-flash"],
      ["claude", "gpt-6.2-sol"],
    ] as const)
      expect(pin(provider, name), `${provider} ${name}`).toThrow(expect.objectContaining({ code: "invalid-selection" }));
    expect(pin("antigravity", "gemini-4-argon")).not.toThrow();
    db.close();
  });

  it("returns a stored pin on another maker's model to automatic, without an error, and keeps the effort pick", async () => {
    const { db, handlers } = setup();
    await handlers.autoConfigure({});
    // What an earlier build allowed: a Claude model and GPT-OSS pinned on Antigravity, and a good pin on Claude.
    const stored = (feature: string, selection: object) =>
      db
        .prepare("INSERT OR REPLACE INTO feature_engines (feature, selection_json, updated_at) VALUES (?, ?, 1)")
        .run(feature, JSON.stringify(selection));
    stored("lesson", { provider: "antigravity", model: "claude-opus-5-5", effort: "high" });
    stored("map", { provider: "antigravity", model: "gpt-oss-120b-medium" });
    stored("plan", { provider: "claude", model: "claude-opus-5-5", effort: "high" });
    const { features } = await handlers.autoConfigure({});
    expect(features.lesson).toMatchObject({ auto: true, effortChoice: "high" });
    expect(features.lesson!.model).toMatch(makers[features.lesson!.provider]!);
    expect(features.map).toMatchObject({ auto: true });
    expect(features.map!.model).not.toBe("gpt-oss-120b-medium");
    // A pin on the maker's own model stays where it is.
    expect(features.plan).toEqual({ provider: "claude", model: "claude-opus-5-5", effort: "high" });
    db.close();
  });
});
