import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function keys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("interface languages", () => {
  const dir = import.meta.dirname;
  const itKeys = keys(
    JSON.parse(readFileSync(resolve(dir, "it.json"), "utf8")),
  );
  const enKeys = keys(
    JSON.parse(readFileSync(resolve(dir, "en.json"), "utf8")),
  );

  it("uses the same keys in Italian and English", () => {
    expect(enKeys.sort()).toEqual(itKeys.sort());
  });

  it('writes "ad", not "a", before a provider whose name starts with a vowel', () => {
    const italian = readFileSync(resolve(dir, "it.json"), "utf8");
    expect(italian.match(/\b[aA] (Anthropic|OpenAI|Ollama|Antigravity)\b/g) ?? []).toEqual([]);
    const notice = JSON.parse(italian).engines.notice as Record<string, string>;
    // EngineNotice picks the `_vowel` string for Anthropic, OpenAI and Antigravity.
    expect(notice.item).toContain(" a {{vendor}}");
    expect(notice.item_vowel).toContain(" ad {{vendor}}");
    expect(notice.itemRelay).toContain(" a {{vendor}}");
    expect(notice.itemRelay_vowel).toContain(" ad {{vendor}}");
  });

  it('defines every key the interface asks for by a literal t("...") call', () => {
    const defined = new Set(
      enKeys.flatMap((key) => [
        key,
        key.replace(/_(zero|one|two|few|many|other)$/, ""),
      ]),
    );
    const files = (folder: string): string[] =>
      readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(folder, entry.name);
        if (entry.isDirectory()) return files(path);
        return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
          ? [path]
          : [];
      });
    const missing: string[] = [];
    for (const file of files(resolve(dir, ".."))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /\bt\(\s*"([A-Za-z][\w-]*(?:\.[\w-]+)+)"/g,
      ))
        if (!defined.has(match[1]!))
          missing.push(
            `${file.slice(resolve(dir, "..").length + 1)}: ${match[1]}`,
          );
    }
    expect(missing).toEqual([]);
  });
});
