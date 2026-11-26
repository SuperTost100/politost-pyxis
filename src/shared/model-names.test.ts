import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { displayModelName, readableModel } from "./model-names";

describe("readableModel", () => {
  it("reads the ids the engines list as names", () => {
    expect(readableModel("claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(readableModel("claude-opus-4-6-thinking")).toBe("Claude Opus 4.6 Thinking");
    expect(readableModel("claude-opus-5")).toBe("Claude Opus 5");
    expect(readableModel("gemini-3.8-flash")).toBe("Gemini 3.8 Flash");
    expect(readableModel("gpt-5.3-codex")).toBe("GPT-5.3 Codex");
    expect(readableModel("gpt-5.6-terra")).toBe("GPT-5.6 Terra");
    // Models of Cursor in saved messages and quiz results.
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

describe("displayModelName", () => {
  it("spells every model id and provider-reported name in one form everywhere", () => {
    expect(displayModelName("gpt-6-luna", "GPT-6-Luna")).toBe("GPT-6 Luna");
    expect(displayModelName("gpt-6.2-sol", "GPT-6.2-Sol")).toBe("GPT-6.2 Sol");
    expect(displayModelName("gpt-6.1-terra", "GPT-6.1 Terra")).toBe("GPT-6.1 Terra");
    expect(displayModelName("gpt-6.2-sol", "gpt-6.2-sol")).toBe("GPT-6.2 Sol");
    expect(displayModelName("gpt-6.2-sol")).toBe("GPT-6.2 Sol");
    expect(displayModelName("gpt-oss-120b", "GPT-OSS 120B (Medium)")).toBe("GPT-OSS 120B (Medium)");
    expect(displayModelName("claude-sonnet-5-5", "Claude Sonnet 5.5")).toBe("Claude Sonnet 5.5");
  });

  it("formats every model id in resources/model-roles.json cleanly and identically with or without a hyphenated provider name", () => {
    const file = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../resources/model-roles.json"), "utf8"),
    ) as { tools: Record<string, { roles: Record<string, { models: string[] }> }> };
    const ids = [
      ...new Set(
        Object.values(file.tools).flatMap((tool) =>
          Object.values(tool.roles).flatMap((role) => role.models),
        ),
      ),
    ];
    expect(ids.length).toBeGreaterThan(20);
    const expected: Record<string, string> = {
      "claude-haiku-5-5": "Claude Haiku 5.5",
      "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
      "claude-sonnet-5-5": "Claude Sonnet 5.5",
      "claude-sonnet-5": "Claude Sonnet 5",
      "claude-sonnet-4-5-20250929": "Claude Sonnet 4.5",
      "claude-opus-5-5": "Claude Opus 5.5",
      "claude-opus-4-6": "Claude Opus 4.6",
      "claude-opus-4-1-20250805": "Claude Opus 4.1",
      "gpt-6-luna": "GPT-6 Luna",
      "gpt-5.6-luna": "GPT-5.6 Luna",
      "gpt-6.1-terra": "GPT-6.1 Terra",
      "gpt-5.6-terra": "GPT-5.6 Terra",
      "gpt-6.2-sol": "GPT-6.2 Sol",
      "gpt-6.1-sol": "GPT-6.1 Sol",
      "gpt-6-sol": "GPT-6 Sol",
      "gpt-5.6-sol": "GPT-5.6 Sol",
      "gpt-6.2-astra": "GPT-6.2 Astra",
      "gpt-6-astra": "GPT-6 Astra",
      "gpt-5-mini": "GPT-5 Mini",
      "gpt-5-nano": "GPT-5 Nano",
      "gpt-5.1": "GPT-5.1",
      "gpt-5": "GPT-5",
      "gemini-3.8-flash": "Gemini 3.8 Flash",
      "gemini-4-hydrogen": "Gemini 4 Hydrogen",
      "gemini-4-argon": "Gemini 4 Argon",
      "gemini-4-carbon": "Gemini 4 Carbon",
      "gemini-4-neon": "Gemini 4 Neon",
    };
    expect(Object.keys(expected).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const display = displayModelName(id);
      expect(display, id).toBe(expected[id]);
      expect(displayModelName(id, display.replace(/^(GPT-\d+(?:\.\d+)*) /, "$1-")), id).toBe(display);
      expect(displayModelName(id, id), id).toBe(display);
    }
  });
});
