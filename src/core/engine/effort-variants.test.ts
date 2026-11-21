import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { collapseEffortVariants, offeredModels } from "./effort-variants";
import { forgetModels, rememberModels } from "./efforts";
import { getFunnel, runTurn } from "./funnel";
import { generate } from "./generate";
import { engineHandlers } from "./handlers";
import { adoptModelFile, modelFile, resetModelFile, type ModelFile } from "./model-roles";
import { benchModel, clearBench } from "./bench";
import type { AutoProvider } from "./auto";
import { currentSelection, fallbackSelection, rememberReady, selectionFor, selectionOn } from "./selection";

vi.mock("./funnel", async (original) => {
  const actual = await original<typeof import("./funnel")>();
  return { ...actual, getFunnel: vi.fn(actual.getFunnel), runTurn: vi.fn() };
});

const levels = (...ids: string[]) => ids.map((id) => ({ id, label: id }));
/**
 * A mixed listing: `gemini-4-neon` with its levels and, next to it, `gemini-4-neon-xhigh` as a model of its own with none.
 * cli-funnel 0.9 made this of `agy models`; cli-funnel 1.0 groups the levels, but leaves a listing that holds both the bare
 * model and suffixed ids as separate models, which Pyxis folds.
 */
const listing = () => [
  { id: "gemini-4-neon", name: "Gemini 4 Neon", efforts: levels("low", "medium", "high") },
  { id: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)", efforts: [] },
  { id: "gemini-4-argon", name: "Gemini 4 Argon", efforts: levels("low", "medium", "high") },
  { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", efforts: levels("low", "medium", "high") },
  { id: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (XHigh)", efforts: [] },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: levels("low", "medium", "high") },
  { id: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)", efforts: [] },
];

const dirs: string[] = [];
afterEach(() => {
  resetModelFile();
  rememberReady([]);
  clearBench();
  forgetModels();
  vi.mocked(getFunnel).mockReset();
  delete process.env.CLI_FUNNEL_AGY_BIN;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("effort variants listed as models in a mixed listing", () => {
  it("shows each model once and gives the model the level its variant stood for", () => {
    const shown = offeredModels("antigravity", listing());
    expect(shown.map((model) => model.id)).toEqual(["gemini-4-neon", "gemini-4-argon", "gemini-4-hydrogen", "gemini-3.8-flash"]);
    expect(shown[0]!.efforts).toEqual(levels("low", "medium", "high").concat({ id: "xhigh", label: "Extra high" }));
    expect(shown[1]!.efforts.map((effort) => effort.id)).toEqual(["low", "medium", "high"]);
    expect(shown[2]!.efforts.map((effort) => effort.id)).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("keeps the level after a higher one when the model lists max, and leaves other models alone", () => {
    const [model] = collapseEffortVariants([
      { id: "m", efforts: levels("low", "max") },
      { id: "m-xhigh", efforts: [] },
    ]);
    expect(model!.efforts.map((effort) => effort.id)).toEqual(["low", "xhigh", "max"]);
    // A variant whose model is not listed, or that lists levels of its own, is a model of its own.
    expect(collapseEffortVariants([{ id: "x-xhigh", efforts: [] }]).map((entry) => entry.id)).toEqual(["x-xhigh"]);
    expect(
      collapseEffortVariants([
        { id: "y", efforts: levels("low") },
        { id: "y-high", efforts: levels("high") },
      ]).map((entry) => entry.id),
    ).toEqual(["y", "y-high"]);
    expect(collapseEffortVariants([{ id: "claude-sonnet-5", efforts: [] }]).map((entry) => entry.id)).toEqual(["claude-sonnet-5"]);
  });
});

describe("a pinned effort reaches the tool in a mixed listing", () => {
  function setup() {
    const capabilities = { effort: true, fast: false, access: ["none"] };
    vi.mocked(getFunnel).mockImplementation(
      () =>
        ({
          overview: async () => [
            { id: "antigravity", displayName: "Antigravity", installation: { installed: true }, auth: { loggedIn: true }, capabilities },
          ],
          models: async () => listing(),
          providers: { antigravity: { capabilities } },
        }) as unknown as ReturnType<typeof getFunnel>,
    );
    const db = openDatabase(":memory:");
    return { db, handlers: engineHandlers(db, () => undefined) };
  }

  it("lists each model once under Advanced, with the variant's level among its efforts", async () => {
    const { db, handlers } = setup();
    const list = await handlers.models({ provider: "antigravity" });
    expect(list.map((model) => model.id)).toEqual(["gemini-4-neon", "gemini-4-argon", "gemini-4-hydrogen", "gemini-3.8-flash"]);
    expect(list[0]!.efforts.map((effort) => effort.id)).toContain("xhigh");
    db.close();
  });

  it("runs a task pinned at xhigh as the variant the tool lists, and the other levels as the model with its effort flag", async () => {
    const { db, handlers } = setup();
    await handlers.models({ provider: "antigravity" });
    handlers.setFeature({ feature: "chat", provider: "antigravity", model: "gemini-4-neon", effort: "xhigh" });
    // The stored choice keeps the model and the level the student picked; the call goes to the variant, with no flag.
    expect(handlers.features().chat).toEqual({ provider: "antigravity", model: "gemini-4-neon", effort: "xhigh" });
    expect(selectionFor(db, "chat")).toEqual({ provider: "antigravity", model: "gemini-4-neon-xhigh" });
    handlers.setEffort({ feature: "chat", effort: "high" });
    expect(selectionFor(db, "chat")).toEqual({ provider: "antigravity", model: "gemini-4-neon", effort: "high" });
    expect(() => handlers.setEffort({ feature: "chat", effort: "max" })).toThrow();
    db.close();
  });
  it("tests a level the tool lists as a model of its own on that model, with no effort flag", async () => {
    const { db, handlers } = setup();
    await handlers.models({ provider: "antigravity" });
    vi.mocked(runTurn).mockImplementation(async (input) => ({ text: "ok", provider: "antigravity", model: input.selection.model, inputTokens: 1 }));
    await handlers.test({ provider: "antigravity", model: "gemini-4-neon", effort: "xhigh" });
    expect(vi.mocked(runTurn).mock.lastCall![0].selection).toMatchObject({ model: "gemini-4-neon-xhigh", effort: undefined });
    await handlers.test({ provider: "antigravity", model: "gemini-4-neon", effort: "high" });
    expect(vi.mocked(runTurn).mock.lastCall![0].selection).toMatchObject({ model: "gemini-4-neon", effort: "high" });
    vi.mocked(runTurn).mockReset();
    db.close();
  });
});

describe("a recovery path runs the variant too in a mixed listing", () => {
  /** A model file whose strong role asks Neon at xhigh, and Antigravity and Claude ready with what the tools list. */
  function xhighStrong() {
    const file = JSON.parse(JSON.stringify(modelFile())) as ModelFile;
    file.updatedAt = "2099-01-01T00:00:00Z";
    file.tools.antigravity!.roles.strong = { effort: "xhigh", models: ["gemini-4-neon", "gemini-4-argon"] };
    expect(adoptModelFile(file)).toBe(true);
    const offered = offeredModels("antigravity", listing());
    rememberModels("antigravity", offered, listing());
    const claude: AutoProvider = {
      id: "claude",
      kind: "cli",
      effort: true,
      models: [{ id: "claude-opus-5-5", efforts: levels("low", "high") }, { id: "claude-sonnet-5-5", efforts: levels("low", "high") }],
    };
    rememberReady([claude, { id: "antigravity", kind: "cli", effort: true, images: false, models: offered }]);
  }

  it("gives the tool's recovery choice the variant's id and no effort flag, as selectionFor does", () => {
    xhighStrong();
    expect(selectionOn("antigravity", "plan")).toEqual({ provider: "antigravity", model: "gemini-4-neon-xhigh" });
  });

  it("does the same when a task moves to the tool from another one", () => {
    xhighStrong();
    for (const reason of ["limit", "signed-out", "not-installed"] as const)
      expect(fallbackSelection({ provider: "claude", chosenFor: "plan" }, reason), reason).toEqual({
        provider: "antigravity",
        model: "gemini-4-neon-xhigh",
      });
  });

  it("and for a saved job selection that is replaced", () => {
    xhighStrong();
    const saved = { provider: "antigravity", model: "claude-opus-5-5", effort: "high", chosenFor: "plan" };
    expect(currentSelection(saved)).toEqual({ provider: "antigravity", model: "gemini-4-neon-xhigh", chosenFor: "plan" });
  });

  it("leaves out the level whose variant the subscription refused, and keeps the model's other levels", () => {
    xhighStrong();
    benchModel("antigravity", "gemini-4-neon-xhigh");
    expect(selectionOn("antigravity", "plan")).toEqual({ provider: "antigravity", model: "gemini-4-neon", effort: "high" });
  });

  it("keeps the base model and the effort flag for a level the tool does not list as a model", () => {
    xhighStrong();
    expect(selectionOn("antigravity", "chat")).toEqual({ provider: "antigravity", model: "gemini-3.8-flash", effort: "low" });
    expect(selectionOn("claude", "plan")).toEqual({ provider: "claude", model: "claude-opus-5-5", effort: "high" });
  });
});

describe("a saved model id from the previous build, with the level folded into it", () => {
  const grouped = [
    { id: "gemini-4-neon", name: "Gemini 4 Neon", efforts: levels("low", "medium", "high", "xhigh") },
    { id: "gemini-4-argon", name: "Gemini 4 Argon", efforts: levels("low", "medium", "high") },
  ];
  const job = { provider: "antigravity", model: "gemini-4-neon-xhigh", chosenFor: "plan" };

  it("resumes as the model at the same effort, in the 1.0 listing, where the id is no longer a model", () => {
    rememberModels("antigravity", grouped, grouped);
    expect(currentSelection(job)).toEqual({ provider: "antigravity", model: "gemini-4-neon", effort: "xhigh", chosenFor: "plan" });
  });

  it("does so before any listing is read, since the job may resume first", () => {
    expect(currentSelection(job)).toEqual({ provider: "antigravity", model: "gemini-4-neon", effort: "xhigh", chosenFor: "plan" });
  });

  it("leaves an id alone when the listing offers no such model with that level", () => {
    rememberModels("antigravity", grouped, grouped);
    expect(currentSelection({ provider: "antigravity", model: "gemini-4-argon-xhigh" })).toMatchObject({ model: "gemini-4-argon-xhigh" });
    expect(currentSelection({ provider: "claude", model: "claude-sonnet-5-xhigh" })).toMatchObject({ model: "claude-sonnet-5-xhigh" });
  });

  it("is what a pinned task saved with that id reads as, with its effort", () => {
    rememberModels("antigravity", grouped, grouped);
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('chat', ?, 1)").run(
      JSON.stringify({ provider: "antigravity", model: "gemini-4-neon-xhigh" }),
    );
    expect(selectionFor(db, "chat")).toEqual({ provider: "antigravity", model: "gemini-4-neon", effort: "xhigh" });
    db.close();
  });

  it("reaches the tool as the model with the effort, which is what cli-funnel 1.0 accepts", async () => {
    rememberModels("antigravity", grouped, grouped);
    const sent: Array<{ model: string; effort?: string }> = [];
    await generate({
      selection: { provider: "antigravity", model: "gemini-4-neon-xhigh" },
      prompt: "x",
      run: async (input) => {
        sent.push({ model: input.selection.model, effort: input.selection.effort });
        return { text: "ok", model: input.selection.model, provider: "antigravity", inputTokens: 1 };
      },
    });
    expect(sent).toEqual([{ model: "gemini-4-neon", effort: "xhigh" }]);
  });

  it("resumes as the variant's id with no effort flag in a mixed listing, where the tool lists it", () => {
    const mixed = listing();
    rememberModels("antigravity", offeredModels("antigravity", mixed), mixed);
    expect(currentSelection(job)).toEqual({ provider: "antigravity", model: "gemini-4-neon-xhigh", chosenFor: "plan" });
  });
});
