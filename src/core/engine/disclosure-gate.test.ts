import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { DISCLOSURE_REQUIRED } from "./disclosure";
import { translateEngineError } from "./errors";
import { configureDisclosure, getFunnel, runTurn } from "./funnel";
import { engineHandlers } from "./handlers";
import { selectionFor } from "./selection";

vi.mock("cli-funnel", async (original) => ({
  ...(await original<typeof import("cli-funnel")>()),
  createFunnel: () => funnel,
}));

const efforts = ["low", "medium", "high"].map((id) => ({ id, label: id }));
const models = {
  claude: ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"],
  codex: ["gpt-6-sol", "gpt-5.6-terra", "gpt-6-luna"],
};
const run = vi.fn();
const row = (id: string, displayName: string) => ({
  id,
  displayName,
  installation: { installed: true },
  auth: { loggedIn: true },
  capabilities: { effort: true, fast: false, access: ["none"] },
});
const funnel = {
  run,
  providers: {
    claude: { capabilities: { effort: true, fast: false, access: ["none"] } },
    codex: { capabilities: { effort: true, fast: false, access: ["none"] } },
  },
  overview: async () => [row("claude", "Claude Code"), row("codex", "Codex")],
  models: async (id: "claude" | "codex") =>
    models[id].map((model) => ({ id: model, name: model, efforts })),
};

describe("provider notice is never raised during a task", () => {
  it("lists every ready engine as unacknowledged and picks none of them for a task", async () => {
    const db = openDatabase(":memory:");
    configureDisclosure(db);
    const handlers = engineHandlers(db, () => undefined);
    const overview = await handlers.overview();
    expect(overview.map((item) => [item.id, item.acknowledged])).toEqual([
      ["claude", false],
      ["codex", false],
    ]);
    const result = await handlers.autoConfigure({});
    expect(result.ready).toEqual(["claude", "codex"]);
    expect(result.features).toEqual({});
    expect(() => selectionFor(db, "chat")).toThrow();
    db.close();
  });

  it("uses only the acknowledged engines once one acknowledgement is recorded for each", async () => {
    const db = openDatabase(":memory:");
    configureDisclosure(db);
    const handlers = engineHandlers(db, () => undefined);
    handlers.acknowledge({ providers: ["claude"] });
    await vi.waitFor(() => expect(Object.keys(handlers.features())).toContain("chat"));
    const only = handlers.features();
    expect(Object.values(only).every((value) => value.provider === "claude")).toBe(true);
    handlers.acknowledge({ providers: ["claude", "codex"] });
    await vi.waitFor(() =>
      expect(
        new Set(Object.values(handlers.features()).map((value) => value.provider)),
      ).toEqual(new Set(["claude", "codex"])),
    );
    expect((await handlers.overview()).every((item) => item.acknowledged)).toBe(true);
    db.close();
  });

  it("refuses to pin an unacknowledged engine and never reaches its provider", async () => {
    const db = openDatabase(":memory:");
    configureDisclosure(db);
    getFunnel();
    const handlers = engineHandlers(db, () => undefined);
    expect(() =>
      handlers.setFeature({ feature: "chat", provider: "codex", model: "gpt-6-luna" }),
    ).toThrow();
    expect(handlers.features()).toEqual({});
    run.mockClear();
    const error = await runTurn({
      selection: { provider: "codex", model: "gpt-6-luna" },
      prompt: "hi",
    }).catch((err: unknown) => err);
    expect(error).toMatchObject({ message: DISCLOSURE_REQUIRED });
    expect(run).not.toHaveBeenCalled();
    expect(translateEngineError(error).messageKey).toBe(
      "engines.errors.disclosure-required",
    );
    handlers.acknowledge({ providers: ["codex"] });
    run.mockResolvedValueOnce({ text: "ok", model: "m", provider: "codex" });
    await runTurn({ selection: { provider: "codex", model: "m" }, prompt: "hi" });
    expect(run).toHaveBeenCalledTimes(1);
    db.close();
  });
});
