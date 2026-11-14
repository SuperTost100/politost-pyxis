import { describe, expect, it } from "vitest";
import type { BackTarget } from "../../app/back-slot";
import { toolLine } from "./toolLine";

const target = (to: string): BackTarget => ({ name: "Teorema di Bayes", label: "", to, go: () => {}, leave: () => {}, busy: false, saves: false });

describe("toolLine", () => {
  it("names a chat", () => expect(toolLine(target("/ask/c-bayes"))).toBe("Teorema di Bayes"));
  it("leaves the line out for a new chat, another page or no way back", () => {
    expect(toolLine(target("/ask"))).toBeUndefined();
    expect(toolLine(target("/tools/graph"))).toBeUndefined();
    expect(toolLine(null)).toBeUndefined();
  });
});
