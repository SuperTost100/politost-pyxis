import { describe, expect, it } from "vitest";
import { engineLabel, engineModelsLine, modelName } from "./engineNames";

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

describe("engineModelsLine", () => {
  const notIncluded = (count: number, models: string) => `${models} (${count}) not included`;
  const features = {
    plan: { provider: "agent", model: "grok-4.7" },
    chat: { provider: "agent", model: "gpt-5.3-codex" },
    lesson: { provider: "claude", model: "claude-sonnet-5" },
  };

  it("names the models the plan gives the engine, then the ones its subscription refused", () => {
    expect(
      engineModelsLine({ names, provider: "agent", features, refused: ["claude-opus-5-5"], notIncluded }),
    ).toBe("Grok 4.7 · Codex 5.3 · Claude Opus 5.5 (1) not included");
  });

  it("keeps the refused models on an engine the student left out, without the plan's models", () => {
    expect(
      engineModelsLine({
        names,
        provider: "agent",
        features,
        refused: ["claude-opus-5-5"],
        allowed: false,
        notIncluded,
      }),
    ).toBe("Claude Opus 5.5 (1) not included");
    expect(engineModelsLine({ names, provider: "agent", features, allowed: false, notIncluded })).toBe("");
  });
});
