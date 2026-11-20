import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { collapseEffortVariants, offeredModels } from "./effort-variants";
import { forgetModels, rememberModels } from "./efforts";
import { getFunnel } from "./funnel";
import { engineHandlers } from "./handlers";
import { adoptModelFile, modelFile, resetModelFile, type ModelFile } from "./model-roles";
import { clearBench } from "./bench";
import type { AutoProvider } from "./auto";
import { currentSelection, fallbackSelection, rememberReady, selectionFor, selectionOn } from "./selection";

vi.mock("./funnel", async (original) => {
  const actual = await original<typeof import("./funnel")>();
  return { ...actual, getFunnel: vi.fn(actual.getFunnel), runTurn: vi.fn() };
});

const levels = (...ids: string[]) => ids.map((id) => ({ id, label: id }));
/** What `agy models` makes of `gemini-4-neon-{low,medium,high}` and the separate `gemini-4-neon-xhigh`, through cli-funnel 0.9. */
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

describe("effort variants listed as models", () => {
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

describe("a pinned effort reaches the tool", () => {
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

  it.skipIf(process.platform === "win32")("finds xhigh listed as an effort of the model itself, which CLI Funnel groups, and starts the ACP server for it", async () => {
    const real = await vi.importActual<typeof import("./funnel")>("./funnel");
    const dir = mkdtempSync(join(tmpdir(), "pyxis-agy-"));
    dirs.push(dir);
    const log = join(dir, "args");
    const bin = join(dir, "agy");
    // It answers the questions Pyxis asks to find the program, and records the arguments of the turn.
    writeFileSync(
      bin,
      `#!/bin/sh\ncase "$1" in --version) echo "1.5.13"; exit 0;; models) printf 'gemini-4-neon-low\\tGemini 4 Neon (Low)\\ngemini-4-neon-high\\tGemini 4 Neon (High)\\ngemini-4-neon-xhigh\\tGemini 4 Neon (XHigh)\\n'; exit 0;; esac\necho "---" >> "${log}"\nprintf '%s\\n' "$@" >> "${log}"\nexit 1\n`,
    );
    chmodSync(bin, 0o755);
    process.env.CLI_FUNNEL_AGY_BIN = bin;
    const funnel = real.getFunnel();
    // The program is asked for its models first, as Pyxis does. CLI Funnel 1.0 puts the level on the model it belongs to.
    const listed = await funnel.models("antigravity");
    expect(listed.map((model) => model.id)).toContain("gemini-4-neon");
    expect(listed.map((model) => model.id)).not.toContain("gemini-4-neon-xhigh");
    expect(listed.find((model) => model.id === "gemini-4-neon")!.efforts.map((effort) => effort.id)).toContain("xhigh");
    const drain = async (stream: ReturnType<typeof funnel.stream>): Promise<string> => {
      try {
        for await (const event of stream) void event;
        await stream.result;
        return "";
      } catch (error) {
        return String(error);
      }
    };
    // So `xhigh` is an effort of `gemini-4-neon` and reaches the tool, which here ends at once.
    expect(
      await drain(
        funnel.stream({ selection: { provider: "antigravity", model: "gemini-4-neon", effort: "xhigh", cwd: dir, access: "none" }, prompt: "hi" }),
      ),
    ).not.toMatch(/does not support effort/);
    // The turn runs `agy acp`, which takes the model and the level from its session, not from flags.
    const turn = readFileSync(log, "utf8").split("---\n").find((block) => block.startsWith("acp\n"))!;
    expect(turn).toBeDefined();
    expect(turn).not.toContain("--effort");
    real.closeFunnel();
  });
});

describe("a recovery path runs the variant too", () => {
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

  it("keeps the base model and the effort flag for a level the tool does not list as a model", () => {
    xhighStrong();
    expect(selectionOn("antigravity", "chat")).toEqual({ provider: "antigravity", model: "gemini-4-hydrogen", effort: "low" });
    expect(selectionOn("claude", "plan")).toEqual({ provider: "claude", model: "claude-opus-5-5", effort: "high" });
  });
});
