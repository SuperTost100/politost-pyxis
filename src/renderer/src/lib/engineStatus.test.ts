import { describe, expect, it } from "vitest";
import { engineStatus, type EngineState } from "./engineStatus";

const cli = (patch: Partial<EngineState>): EngineState => ({
  kind: "cli",
  installed: true,
  loggedIn: true,
  refused: false,
  disabled: false,
  ...patch,
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
