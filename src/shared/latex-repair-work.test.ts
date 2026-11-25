import { describe, expect, it, vi } from "vitest";

// Counts the scans that tell whether a place is inside a formula: each one reads the text from its start.
const scans = vi.hoisted(() => ({ count: 0 }));
vi.mock("./inside-math", async (importOriginal) => {
  const original = await importOriginal<typeof import("./inside-math")>();
  return {
    insideMath: (text: string, index: number) => {
      scans.count++;
      return original.insideMath(text, index);
    },
  };
});

const { repairLatexEscapes } = await import("./latex-repair");

describe("the work of reading a line break written as \\n", () => {
  it("scans for a formula only where the letters after \\n can be a command", () => {
    // A long answer without maths whose line breaks were written twice: no `\n` in it is followed by a command name.
    const text = "Prima riga del testo.\\nAltra riga, e poi\\nuna nuova.\\n".repeat(2000);
    scans.count = 0;
    expect(repairLatexEscapes(text)).toBe(text.replaceAll("\\n", "\n"));
    expect(scans.count).toBe(0);
    // Each `\n` before a command name is one scan.
    scans.count = 0;
    repairLatexEscapes(`${text}$\\nabla f$ e $\\nu$`);
    expect(scans.count).toBe(2);
  });
});
