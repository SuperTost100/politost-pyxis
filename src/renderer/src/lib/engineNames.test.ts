import { describe, expect, it } from "vitest";
import { engineLabel, engineModelsLine, engineName, modelName } from "./engineNames";

const names = {
  engines: { antigravity: "Gemini" },
  models: { antigravity: { "gpt-5.3-codex": "Codex 5.3" } },
};

describe("engineLabel", () => {
  it("names the engine and the model the way the model picker does", () => {
    expect(engineLabel(names, "antigravity", "gpt-5.3-codex")).toBe("Gemini · Codex 5.3");
  });

  it("makes an id readable when core has not listed the model", () => {
    expect(engineLabel(names, "antigravity", "gemini-3.8-flash")).toBe("Gemini · Gemini 3.8 Flash");
    expect(engineLabel(undefined, "claude", "claude-sonnet-4-6")).toBe("Claude · Claude Sonnet 4.6");
  });

  it("names Cursor on an old record that still says agent, with no names from core", () => {
    expect(engineName(undefined, "agent")).toBe("Cursor");
    expect(engineLabel(undefined, "agent", "cursor-grok-4.6")).toBe("Cursor · Grok 4.6");
    expect(engineName({ engines: {}, models: {} }, "agent")).toBe("Cursor");
  });

  it("leaves out a part an old record lacks", () => {
    expect(engineLabel(names, undefined, "claude-opus-4-6-thinking")).toBe("Claude Opus 4.6 Thinking");
    expect(engineLabel(names, "antigravity", null)).toBe("Gemini");
    expect(modelName(names, "codex", "gpt-5.3-codex")).toBe("GPT-5.3 Codex");
  });
});

describe("engineModelsLine", () => {
  const notIncluded = (count: number, models: string) => `${models} (${count}) not included`;
  const features = {
    plan: { provider: "antigravity", model: "gemini-4-argon" },
    chat: { provider: "antigravity", model: "gpt-5.3-codex" },
    lesson: { provider: "claude", model: "claude-sonnet-5" },
  };

  it("names the models the plan gives the engine, then the ones its subscription refused", () => {
    expect(
      engineModelsLine({ names, provider: "antigravity", features, refused: ["claude-opus-5-5"], notIncluded }),
    ).toBe("Gemini 4 Argon · Codex 5.3 · Claude Opus 5.5 (1) not included");
  });

  it("keeps the refused models on an engine the student left out, without the plan's models", () => {
    expect(
      engineModelsLine({
        names,
        provider: "antigravity",
        features,
        refused: ["claude-opus-5-5"],
        allowed: false,
        notIncluded,
      }),
    ).toBe("Claude Opus 5.5 (1) not included");
    expect(engineModelsLine({ names, provider: "antigravity", features, allowed: false, notIncluded })).toBe("");
  });
});
