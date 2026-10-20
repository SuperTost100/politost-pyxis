import { describe, expect, it } from "vitest";
import { fencedChecks, stripCheckFences } from "./math-check";

describe("math check fences", () => {
  it.each(["check", "json"])("anchors and hides a valid %s claim", (language) => {
    const step = "The result is 2.";
    const body = `${step}\n\n\`\`\`${language}\n${JSON.stringify({ kind: "equal", expr: "1+1", claimed: "2", step })}\n\`\`\``;
    expect(fencedChecks(body)).toEqual([{ kind: "equal", expr: "1+1", claimed: "2", step }]);
    expect(stripCheckFences(body).trim()).toBe(step);
  });

  it("keeps ordinary, malformed and incomplete JSON visible", () => {
    for (const content of ['{"title":"Example"}', '{"kind":"equal","expr":"1+1"}', "{"]) {
      const body = `\`\`\`json\n${content}\n\`\`\``;
      expect(stripCheckFences(body)).toBe(body);
      expect(fencedChecks(body)).toEqual([]);
    }
    expect(stripCheckFences("```json\n{\"kind\":")).toBe("```json\n{\"kind\":");
  });

  it("hides a check block that a stopped reply left open, and keeps an open json block", () => {
    expect(stripCheckFences('Passo uno.\n\n```check\n{"kind":"equal","expr":"1+')).toBe("Passo uno.\n\n");
    expect(stripCheckFences('A\n```check\n{"kind":"equal"}\n```\nB\n```check\n{"ki')).toBe("A\n\nB\n");
  });

  it("does not attach an invented step to surrounding prose", () => {
    const body = 'Real explanation.\n\n```json\n{"kind":"equal","expr":"1+1","claimed":"2","step":"Invented step"}\n```';
    expect(fencedChecks(body)).toEqual([]);
  });
});
