import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { implemented, omitted } from "./requirements";

const featuresPath = join(
  import.meta.dirname,
  "../../../plan-and-resources/Features and functionalities.md",
);

function idsFromFeaturesDoc(text: string): Set<string> {
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    if (/\bLater\b/.test(line)) continue;
    const match = line.match(/\b([A-Z]{2,4}-\d{2})\b/);
    const id = match?.[1];
    if (id) ids.add(id);
  }
  return ids;
}

describe("requirements registry", () => {
  // ponytail: the features doc lives outside this repo. A standalone clone still runs the duplicate checks. An empty file still fails.
  const doc = existsSync(featuresPath) ? readFileSync(featuresPath, "utf8") : null;
  const documented = doc == null ? new Set<string>() : idsFromFeaturesDoc(doc);
  const all = [...implemented, ...omitted];

  it("has no duplicate IDs across implemented and omitted", () => {
    expect(new Set(all).size).toBe(all.length);
  });

  it("lists only IDs that appear in the features doc", () => {
    if (doc == null) return;
    for (const id of all) {
      expect(documented.has(id), id).toBe(true);
    }
  });

  it("traces every current requirement or explicit omission", () => {
    if (doc == null) return;
    const traced = new Set<string>(all);
    expect([...documented].filter((id) => !traced.has(id))).toEqual([]);
  });

  it("never lists an ID from a Later line", () => {
    if (doc == null) return;
    const later = new Set<string>();
    for (const line of doc.split("\n")) {
      if (!/\bLater\b/.test(line)) continue;
      const match = line.match(/\b([A-Z]{2,4}-\d{2})\b/);
      const id = match?.[1];
      if (id) later.add(id);
    }
    for (const id of all) {
      expect(later.has(id), id).toBe(false);
    }
  });

  it("keeps implemented and omitted disjoint", () => {
    const omit = new Set<string>(omitted);
    for (const id of implemented) {
      expect(omit.has(id), id).toBe(false);
    }
  });
});
