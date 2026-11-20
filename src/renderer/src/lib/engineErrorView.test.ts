import { describe, expect, it } from "vitest";
import { engineErrorView, errorProvider } from "./engineErrorView";

describe("engineErrorView", () => {
  it("names a signed-out engine and offers its sign-in", () => {
    expect(
      engineErrorView("engines.errors.not-logged-in", "codex", "Codex"),
    ).toEqual({
      key: "engines.errors.signedOutNamed",
      params: { name: "Codex" },
      signIn: "codex",
    });
  });

  it("names the engine before the engine list has loaded", () => {
    expect(
      engineErrorView("engines.errors.not-logged-in", "antigravity").params,
    ).toEqual({ name: "Gemini" });
  });

  it("offers no sign-in for an API key, and keeps every other message", () => {
    expect(
      engineErrorView("engines.errors.not-logged-in", "openai-api").signIn,
    ).toBeUndefined();
    expect(engineErrorView("engines.errors.quota", "codex")).toEqual({
      key: "engines.errors.quota",
      params: {},
    });
    // Without the engine it keeps the general message that points to Settings.
    expect(engineErrorView("engines.errors.not-logged-in", undefined).key).toBe(
      "engines.errors.not-logged-in",
    );
  });

  it("names the engine whose subscription refused the model and offers another model", () => {
    expect(
      engineErrorView("engines.errors.model-not-included", "antigravity", "Antigravity"),
    ).toEqual({
      key: "engines.errors.modelNotIncludedNamed",
      params: { name: "Antigravity" },
      chooseModel: true,
    });
    // Without the engine it keeps the general message.
    expect(engineErrorView("engines.errors.model-not-included", undefined)).toEqual({
      key: "engines.errors.model-not-included",
      params: {},
    });
  });

  it("reads an error of a tool Pyxis no longer offers as history: named, with no sign-in and no choice of model to offer", () => {
    for (const key of ["engines.errors.not-logged-in", "engines.errors.model-not-included", "engines.errors.quota"])
      expect(engineErrorView(key, "agent")).toEqual({ key: "engines.errors.retiredTool", params: { name: "Cursor" } });
    // A tool Pyxis does offer keeps its own messages.
    expect(engineErrorView("engines.errors.quota", "codex").key).toBe("engines.errors.quota");
  });

  it("reads the engine an error body carries", () => {
    expect(errorProvider({ params: { provider: "codex" } })).toBe("codex");
    expect(errorProvider({ params: {} })).toBeUndefined();
    expect(errorProvider(null)).toBeUndefined();
  });
});
