import { describe, expect, it } from "vitest";
import { savedToolLine } from "../../../shared/tool-blocks";
import { render } from "./formulaTestKit";

/**
 * A tool block is drawn from a fence in the language `pyxis-tool` wherever Markdown puts one, a block quote and a list item
 * included, so core neutralises every such fence the model writes, and a saved reply never shows a working state.
 */
describe("tool blocks in a reply", () => {
  it("are read as a fence in a block quote and in a list item, which the view would draw as the tool at work", () => {
    expect(render("> ```pyxis-tool\n> pending:create_flashcards\n> ```", false)).toContain('class="language-pyxis-tool"');
    expect(render("- voce\n\n  ```pyxis-tool\n  pending:create_flashcards\n  ```", false)).toContain('class="language-pyxis-tool"');
  });

  it("show a result in a saved reply, and never a working state", () => {
    expect(savedToolLine("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")).toBe("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
    expect(savedToolLine("pending:create_flashcards")).toBeNull();
  });
});
