import { describe, expect, it } from "vitest";
import { installableProviders } from "./installers";
import { currentToolLabel, TOOL_NAMES, TOOL_PROGRAMS } from "./tool-names";

describe("tool names", () => {
  it("names every installable tool as a student knows it, never by its program", () => {
    expect(installableProviders.map((id) => TOOL_NAMES[id])).toEqual(["Claude", "ChatGPT", "Cursor", "Gemini"]);
    for (const id of installableProviders) expect(TOOL_NAMES[id]).not.toBe(TOOL_PROGRAMS[id]);
  });

  it("reads a name stored under the program's name as the tool's name", () => {
    expect(currentToolLabel("Claude Code")).toBe("Claude");
    expect(currentToolLabel("Cursor Agent (Grok 4.7)")).toBe("Cursor (Grok 4.7)");
    expect(currentToolLabel("Codex")).toBe("ChatGPT");
    expect(currentToolLabel("Antigravity")).toBe("Gemini");
  });

  it("leaves any other text alone", () => {
    expect(currentToolLabel("Claude")).toBe("Claude");
    expect(currentToolLabel("Ollama")).toBe("Ollama");
    expect(currentToolLabel("Codexo")).toBe("Codexo");
  });
});
