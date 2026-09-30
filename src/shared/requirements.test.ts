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
    if (match) ids.add(match[1]);
  }
  return ids;
}

describe("requirements registry", () => {
  // ponytail: the features doc lives outside this repo. A standalone clone still runs the duplicate checks.
  const doc = existsSync(featuresPath) ? readFileSync(featuresPath, "utf8") : "";
  const documented = idsFromFeaturesDoc(doc);
  const all = [...implemented, ...omitted];

  it("has no duplicate IDs across implemented and omitted", () => {
    expect(new Set(all).size).toBe(all.length);
  });

  it("lists only IDs that appear in the features doc", () => {
    if (!doc) return;
    for (const id of all) {
      expect(documented.has(id), id).toBe(true);
    }
  });

  it("never lists an ID from a Later line", () => {
    if (!doc) return;
    const later = new Set<string>();
    for (const line of doc.split("\n")) {
      if (!/\bLater\b/.test(line)) continue;
      const match = line.match(/\b([A-Z]{2,4}-\d{2})\b/);
      if (match) later.add(match[1]);
    }
    for (const id of all) {
      expect(later.has(id), id).toBe(false);
    }
  });

  it("keeps implemented and omitted disjoint", () => {
    const omit = new Set(omitted);
    for (const id of implemented) {
      expect(omit.has(id), id).toBe(false);
    }
  });
});
