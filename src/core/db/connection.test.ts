import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "./connection";

describe("openDatabase", () => {
  it("uses WAL with NORMAL sync, a 32 MB cache and memory-mapped reads", () => {
    const db = openDatabase(
      join(mkdtempSync(join(tmpdir(), "pyxis-db-")), "pyxis.db"),
    );
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    // 1 is NORMAL.
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
    expect(db.pragma("cache_size", { simple: true })).toBe(-32000);
    expect(db.pragma("mmap_size", { simple: true })).toBe(268435456);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });
});

describe("closeDatabase", () => {
  it("leaves every write in pyxis.db and an empty WAL", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pyxis-db-")), "pyxis.db");
    const db = openDatabase(file);
    // A second connection keeps the WAL file from being removed on close, so the checkpoint itself is visible.
    const reader = openDatabase(file);
    db.prepare(
      "INSERT INTO subjects (id, name, created_at) VALUES ('s', 'Fisica', 1)",
    ).run();
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(0);
    closeDatabase(db);
    expect(db.open).toBe(false);
    expect(statSync(`${file}-wal`).size).toBe(0);
    reader.close();
    expect(existsSync(`${file}-wal`)).toBe(false);
    closeDatabase(db);
  });
});
