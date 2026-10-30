import { describe, expect, it } from "vitest";
import { readableModel } from "./model-names";

describe("readableModel", () => {
  it("reads the ids the engines list as names", () => {
    expect(readableModel("claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(readableModel("claude-opus-4-6-thinking")).toBe("Claude Opus 4.6 Thinking");
    expect(readableModel("claude-opus-5")).toBe("Claude Opus 5");
    expect(readableModel("gemini-3.8-flash")).toBe("Gemini 3.8 Flash");
    expect(readableModel("gpt-5.3-codex")).toBe("GPT-5.3 Codex");
    expect(readableModel("gpt-5.6-terra")).toBe("GPT-5.6 Terra");
    expect(readableModel("grok-4.7")).toBe("Grok 4.7");
    expect(readableModel("cursor-grok-4.6")).toBe("Grok 4.6");
    expect(readableModel("composer-2.5")).toBe("Composer 2.5");
    expect(readableModel("gemma3:12b")).toBe("Gemma3 12B");
  });

  it("drops a snapshot date, which says when and not which model", () => {
    expect(readableModel("claude-sonnet-4-5-20250929")).toBe("Claude Sonnet 4.5");
  });

  it("keeps an id it cannot split", () => {
    expect(readableModel("")).toBe("");
    expect(readableModel("o3")).toBe("O3");
  });
});
