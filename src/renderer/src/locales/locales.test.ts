import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInstance } from "i18next";
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

  it("asks every delete or remove confirmation the same way: an infinitive in Italian, the verb first in English", () => {
    const read = (file: string) => JSON.parse(readFileSync(resolve(dir, file), "utf8")) as Record<string, unknown>;
    const titles = (tree: Record<string, unknown>) =>
      keys(tree)
        .filter((key) => /\.(deleteTitle|removeTitle)$/.test(key))
        .map((key): [string, string] => [
          key,
          String(key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree)),
        ]);
    const italian = titles(read("it.json"));
    expect(italian.length).toBeGreaterThan(4);
    for (const [key, text] of italian) expect(text, key).toMatch(/^(Eliminare|Rimuovere) .*\?$/);
    for (const [key, text] of titles(read("en.json"))) expect(text, key).toMatch(/^(Delete|Remove) .*\?$/);
  });

  it("puts a name the student gave in «…» in Italian and “…” in English, in every confirmation title and the sentences about it", () => {
    const read = (file: string) => JSON.parse(readFileSync(resolve(dir, file), "utf8")) as Record<string, unknown>;
    const strings = (tree: Record<string, unknown>) =>
      keys(tree).map((key): [string, string] => [
        key,
        String(key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree)),
      ]);
    const italian = strings(read("it.json"));
    const english = strings(read("en.json"));
    const titles = (all: Array<[string, string]>) =>
      all.filter(([key, text]) => /(deleteTitle|removeTitle|removeSourceTitle|unlinkTitle|findTitle)$/.test(key) && text.includes("{{"));
    expect(titles(italian).length).toBeGreaterThan(5);
    for (const [key, text] of titles(italian)) expect(text, key).toMatch(/«\{\{\w+\}\}»/);
    for (const [key, text] of titles(english)) expect(text, key).toMatch(/“\{\{\w+\}\}”/);
    // Never the other language's marks, and never a variable that names a thing in one language and not the other.
    for (const [key, text] of italian) expect(text, key).not.toMatch(/[“”]\{\{|\}\}[“”]/);
    for (const [key, text] of english) expect(text, key).not.toMatch(/[«»]/);
  });

  it("counts what is done, not what there is, in the lines that read 'X of Y'", async () => {
    const read = (file: string) => JSON.parse(readFileSync(resolve(dir, file), "utf8")) as Record<string, unknown>;
    const say = async (lng: "it" | "en") => {
      const i18n = createInstance();
      await i18n.init({
        lng,
        resources: { it: { translation: read("it.json") }, en: { translation: read("en.json") } },
        interpolation: { escapeValue: false },
      });
      return i18n.t;
    };
    const it_ = await say("it");
    expect([0, 1, 2].map((count) => it_("examPage.stepsDone", { count, total: 3 }))).toEqual([
      "0 passi completati su 3",
      "1 passo completato su 3",
      "2 passi completati su 3",
    ]);
    expect([1, 2].map((count) => it_("smart.recapProgress", { count, total: 3 }))).toEqual(["1 risposta su 3", "2 risposte su 3"]);
    const en = await say("en");
    expect([1, 2].map((count) => en("examPage.stepsDone", { count, total: 3 }))).toEqual(["1 of 3 steps done", "2 of 3 steps done"]);
  });

  it('writes "ad", not "a", before a provider whose name starts with a vowel', () => {
    const italian = readFileSync(resolve(dir, "it.json"), "utf8");
    expect(italian.match(/\b[aA] (Anthropic|OpenAI|Ollama|Antigravity)\b/g) ?? []).toEqual([]);
    const notice = JSON.parse(italian).engines.notice as Record<string, string>;
    // EngineNotice picks the `_vowel` string for Anthropic, OpenAI and Antigravity.
    expect(notice.item).toContain(" a {{vendor}}");
    expect(notice.item_vowel).toContain(" ad {{vendor}}");
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
