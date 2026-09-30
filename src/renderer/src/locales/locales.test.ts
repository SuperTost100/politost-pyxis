import { readFileSync } from "node:fs";
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
});
