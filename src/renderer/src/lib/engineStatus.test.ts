import { describe, expect, it } from "vitest";
import {
  choiceRows,
  chosenStart,
  engineStatus,
  type EngineState,
} from "./engineStatus";

const cli = (patch: Partial<EngineState>): EngineState => ({
  kind: "cli",
  installed: true,
  loggedIn: true,
  refused: false,
  disabled: false,
  ...patch,
});

describe("the engines the student can pick", () => {
  const row = (id: string, kind: "cli" | "api", patch: Partial<EngineState> = {}) => ({
    id,
    ...cli({ kind, ...patch }),
  });

  it("lists the CLIs and every API provider with a key, never one this build does not offer", () => {
    const rows = [
      row("claude", "cli"),
      row("codex", "cli", { installed: false, loggedIn: false }),
      row("openai-api", "api"),
      row("anthropic-api", "api", { loggedIn: false }),
      row("agent", "cli", { disabled: true }),
    ];
    expect(choiceRows(rows, ["openai"]).map((item) => item.id)).toEqual([
      "claude",
      "codex",
      "openai-api",
    ]);
  });

  it("starts the student's pick from every ready engine, API providers included", () => {
    expect(
      chosenStart([
        row("claude", "cli", { loggedIn: false }),
        row("openai-api", "api"),
      ]),
    ).toEqual(["openai-api"]);
    expect(
      chosenStart([row("claude", "cli"), row("openai-api", "api")]),
    ).toEqual(["claude", "openai-api"]);
    // With nothing ready, the installed engines, so ticking starts from what is there.
    expect(chosenStart([row("claude", "cli", { loggedIn: false })])).toEqual([
      "claude",
    ]);
  });
});

describe("engineStatus", () => {
  it("reads a signed-in engine as ready", () => {
    expect(engineStatus(cli({}))).toEqual({
      tone: "ok",
      label: "engines.state.ready",
      fix: null,
    });
  });

  it("never reads an engine whose sign-in was refused as ready, and offers sign-in", () => {
    expect(engineStatus(cli({ loggedIn: false, refused: true }))).toEqual({
      tone: "error",
      label: "engines.state.refused",
      fix: "signIn",
    });
  });

  it("offers sign-in for a signed-out CLI and install for a missing one", () => {
    expect(engineStatus(cli({ loggedIn: false })).fix).toBe("signIn");
    expect(engineStatus(cli({ installed: false, loggedIn: false }))).toEqual({
      tone: "idle",
      label: "engines.notInstalled",
      fix: "install",
    });
  });

  it("offers nothing to an API key without a sign-in, or an engine this build does not offer", () => {
    expect(engineStatus({ ...cli({ loggedIn: false }), kind: "api" }).fix).toBeNull();
    expect(engineStatus(cli({ disabled: true }))).toMatchObject({
      label: "engines.unavailable",
      fix: null,
    });
  });
});
