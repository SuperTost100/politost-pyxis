import { expect, it } from "vitest";
import { chunkText } from "./chunk";

it("SRC-20 covers a long section with sentence overlap and original ranges", () => {
  const text = Array.from({ length: 20 }, (_, i) => `Sentence ${i} has a useful detail.`).join(" ");
  const chunks = chunkText(text, 120);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(chunk.text).toBe(text.slice(chunk.start, chunk.end).trim());
    expect(chunk.text.length).toBeLessThanOrEqual(120);
  }
  expect(chunks[1]!.start).toBeLessThan(chunks[0]!.end);
  for (let i = 0; i < 20; i++) expect(chunks.some((chunk) => chunk.text.includes(`Sentence ${i} `))).toBe(true);
});

it("SRC-20 preserves long LaTeX and code blocks even above the chunk target", () => {
  const math = `$$\n${"x + ".repeat(50)}y\n$$`;
  const code = `\x60\x60\x60python\n${"print(1)\n".repeat(30)}\x60\x60\x60`;
  const chunks = chunkText(`A short sentence.\n\n${math}\n\n${code}\n\nEnding sentence.`, 80);
  expect(chunks.some((chunk) => chunk.text.includes(math))).toBe(true);
  expect(chunks.some((chunk) => chunk.text.includes(code))).toBe(true);
  expect(chunks.some((chunk) => chunk.text.includes("Ending sentence."))).toBe(true);
});
