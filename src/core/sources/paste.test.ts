import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { sourceHandlers } from "./handlers";
import { PASTE_MIN } from "./paste";
import { sourceImports } from "./test-import";
import { tempDir } from "../test-temp";
import { retrieve } from "./retrieve";

describe("pasted text", () => {
  it("refuses a note shorter than one page", () => {
    const db = openDatabase(":memory:");
    const handlers = sourceHandlers(db, tempDir("pyxis-paste-short-"), createRunner(db, () => {}));
    expect(() => handlers.paste({ title: "Note", text: "troppo corto" })).toThrow(
      expect.objectContaining({ messageKey: "sources.pasteShort" }),
    );
  });

  it("stores a long paste as searchable passages", async () => {
    const db = openDatabase(":memory:");
    const dir = tempDir("pyxis-paste-");
    const body = `${"La velocità è la derivata dello spazio. ".repeat(80)}`;
    expect(body.length).toBeGreaterThan(PASTE_MIN);
    await sourceImports(db, dir).data(new TextEncoder().encode(body), ".txt", "Cinematica");
    expect(retrieve(db, "velocità").hits[0]?.text).toContain("derivata");
  });
});
