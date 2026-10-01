import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { PASTE_MIN, importPastedText } from "./paste";
import { searchPassages } from "./smartbook";

describe("pasted text", () => {
  it("refuses a note shorter than one page", () => {
    const db = openDatabase(":memory:");
    expect(() => importPastedText(db, tmpdir(), "Note", "troppo corto")).toThrow(/paste-short/);
  });

  it("stores a long paste as searchable passages", () => {
    const db = openDatabase(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "pyxis-paste-"));
    const body = `${"La velocità è la derivata dello spazio. ".repeat(80)}`;
    expect(body.length).toBeGreaterThan(PASTE_MIN);
    const stored = importPastedText(db, dir, "Cinematica", body);
    expect(stored.passages).toBeGreaterThan(0);
    expect(searchPassages(db, "velocità")[0]?.text).toContain("derivata");
  });
});
