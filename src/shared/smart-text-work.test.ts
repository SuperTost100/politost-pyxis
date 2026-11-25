import { describe, expect, it, vi } from "vitest";

// Counts how often the Markdown of a string is parsed to find its code, which is the costly part of reading an escape by
// the text around it.
const parses = vi.hoisted(() => ({ count: 0 }));
vi.mock("./outside-code", async (importOriginal) => {
  const original = await importOriginal<typeof import("./outside-code")>();
  return {
    ...original,
    codeRanges: (input: string) => {
      parses.count++;
      return original.codeRanges(input);
    },
  };
});

const { parseLooseJson } = await import("./smart-text");

describe("reading the escapes of a block by the text around them", () => {
  it("parses each string once, however many ambiguous escapes it has", () => {
    // Forty single-backslash commands in one string and twenty in another, as a model writes them in JSON.
    const formula = String.raw`$a \neq b$ e $x \to 0$ e $\nu \times 2$, `;
    const body = `{"body": "${formula.repeat(20)}", "steps": ["${formula.repeat(10)}"]}`;
    parses.count = 0;
    const value = parseLooseJson(body) as { body: string; steps: string[] };
    expect(value.body).toContain(String.raw`$a \neq b$ e $x \to 0$ e $\nu \times 2$`);
    expect(value.steps[0]).toContain(String.raw`$\nu \times 2$`);
    expect(parses.count).toBeLessThanOrEqual(2);
  });
});
