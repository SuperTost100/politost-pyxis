import { describe, expect, it } from "vitest";
import { installableProviders } from "./installers";
import { currentToolLabel, RETIRED_TOOL_NAMES, TOOL_NAMES, TOOL_PROGRAMS } from "./tool-names";

describe("tool names", () => {
  it("names every installable tool as a student knows it, never by its program", () => {
    expect(installableProviders.map((id) => TOOL_NAMES[id])).toEqual(["Claude", "ChatGPT", "Gemini"]);
    for (const id of installableProviders) expect(TOOL_NAMES[id]).not.toBe(TOOL_PROGRAMS[id]);
  });

  it("reads a name stored under the program's name as the tool's name", () => {
    expect(currentToolLabel("Claude Code")).toBe("Claude");
    expect(currentToolLabel("Antigravity (Gemini 4 Argon)")).toBe("Gemini (Gemini 4 Argon)");
    expect(currentToolLabel("Codex")).toBe("ChatGPT");
    expect(currentToolLabel("Antigravity")).toBe("Gemini");
  });

  it("keeps a display-only name for Cursor, so an old record still reads Cursor, and never offers it", () => {
    expect(RETIRED_TOOL_NAMES.agent).toBe("Cursor");
    expect(TOOL_NAMES.agent).toBeUndefined();
    expect(currentToolLabel("Cursor Agent (Grok 4.7)")).toBe("Cursor (Grok 4.7)");
    expect(currentToolLabel("Cursor Agent")).toBe("Cursor");
  });

  it("leaves any other text alone", () => {
    expect(currentToolLabel("Claude")).toBe("Claude");
    expect(currentToolLabel("Ollama")).toBe("Ollama");
    expect(currentToolLabel("Codexo")).toBe("Codexo");
  });
});
