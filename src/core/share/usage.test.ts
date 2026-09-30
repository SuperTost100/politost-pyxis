import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { putBlob } from "../blobs";
import { openDatabase } from "../db/connection";
import { planDiskUsage } from "./usage";
import { wipeWorkspace } from "./wipe";

describe("plan disk usage", () => {
  it("counts each source file on the plans that use it", () => {
    const dir = mkdtempSync(join(tmpdir(), "pyxis-use-"));
    const db = openDatabase(join(dir, "pyxis.db"));
    const sha = putBlob(dir, new Uint8Array([1, 2, 3, 4]), "text/plain", "txt");
    db.prepare(
      `INSERT INTO sources (id, kind, title, blob_sha, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("s1", "file", "Note", sha, 1, 1);
    db.prepare(
      `INSERT INTO plans (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run("p1", "Fisica", 1, 1);
    db.prepare(
      `INSERT INTO plans (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run("p2", "Vuoto", 2, 2);
    db.prepare(`INSERT INTO plan_sources (plan_id, source_id) VALUES (?, ?)`).run("p1", "s1");
    const usage = planDiskUsage(db, dir);
    expect(usage).toEqual([
      { id: "p1", title: "Fisica", bytes: 4 },
      { id: "p2", title: "Vuoto", bytes: 0 },
    ]);
    db.close();
  });

  it("removes the database and source files, then recreates the folders", () => {
    const dir = mkdtempSync(join(tmpdir(), "pyxis-wipe-"));
    writeFileSync(join(dir, "pyxis.db"), "x");
    wipeWorkspace(dir);
    expect(existsSync(join(dir, "pyxis.db"))).toBe(false);
    expect(existsSync(join(dir, "blobs"))).toBe(true);
    expect(() => wipeWorkspace("/")).toThrow(/workspace-path/);
  });
});
