import { describe, expect, it } from "vitest";
import { engineLabel, modelName } from "./engineNames";

const names = {
  engines: { agent: "Cursor Agent", antigravity: "Antigravity" },
  models: { agent: { "gpt-5.3-codex": "Codex 5.3" } },
};

describe("engineLabel", () => {
  it("names the engine and the model the way the model picker does", () => {
    expect(engineLabel(names, "agent", "gpt-5.3-codex")).toBe("Cursor Agent · Codex 5.3");
  });

  it("makes an id readable when core has not listed the model", () => {
    expect(engineLabel(names, "antigravity", "gemini-3.8-flash")).toBe("Antigravity · Gemini 3.8 Flash");
    expect(engineLabel(undefined, "claude", "claude-sonnet-4-6")).toBe("Claude Code · Claude Sonnet 4.6");
  });

  it("leaves out a part an old record lacks", () => {
    expect(engineLabel(names, undefined, "claude-opus-4-6-thinking")).toBe("Claude Opus 4.6 Thinking");
    expect(engineLabel(names, "agent", null)).toBe("Cursor Agent");
    expect(modelName(names, "codex", "gpt-5.3-codex")).toBe("GPT-5.3 Codex");
  });
});
