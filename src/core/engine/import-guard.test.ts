import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

describe("cli-funnel import", () => {
  it("stays inside the engine module", () => {
    const root = join(import.meta.dirname, "../..");
    const allowed = join(root, "core/engine/funnel.ts");
    const offenders = files(root).filter((path) => {
      if (path === allowed) return false;
      return /from ["']cli-funnel["']|require\(["']cli-funnel["']\)/.test(
        readFileSync(path, "utf8"),
      );
    });
    expect(offenders).toEqual([]);
  });
});
