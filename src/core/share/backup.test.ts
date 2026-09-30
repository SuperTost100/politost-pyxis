import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { uuidv7 } from "../../shared/ids";
import { backupWorkspace, restoreWorkspace } from "./backup";

describe("backupWorkspace / restoreWorkspace", () => {
  it("restores a vacuumed backup and rejects corrupt zips", () => {
    const root = mkdtempSync(join(tmpdir(), "pyxis-ws-"));
    const workspace = join(root, "ws");
    const zipPath = join(root, "backup.zip");
    const fakeZip = join(root, "bad.zip");

    try {
      mkdirSync(workspace, { recursive: true });
      const planId = uuidv7();
      const originalTitle = "Fisica";
      const db = openDatabase(join(workspace, "pyxis.db"));
      db.prepare(
        `INSERT INTO plans (id, title, status, created_at, updated_at) VALUES (?, ?, 'ready', 1, 1)`,
      ).run(planId, originalTitle);
      db.close();

      backupWorkspace(workspace, zipPath);

      const live = openDatabase(join(workspace, "pyxis.db"));
      live.prepare(`UPDATE plans SET title = ? WHERE id = ?`).run("Mutated", planId);
      live.close();

      restoreWorkspace(zipPath, workspace);

      const restored = openDatabase(join(workspace, "pyxis.db"));
      const row = restored
        .prepare(`SELECT title FROM plans WHERE id = ?`)
        .get(planId) as { title: string };
      restored.close();
      expect(row.title).toBe(originalTitle);

      writeFileSync(fakeZip, randomBytes(8));
      expect(() => restoreWorkspace(fakeZip, workspace)).toThrow(/backup-corrupt/);

      const afterCorrupt = openDatabase(join(workspace, "pyxis.db"));
      const still = afterCorrupt
        .prepare(`SELECT title FROM plans WHERE id = ?`)
        .get(planId) as { title: string };
      afterCorrupt.close();
      expect(still.title).toBe(originalTitle);

      const alien = join(root, "alien.db");
      const raw = new Database(alien);
      raw.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY)`);
      raw.close();
      const alienZip = join(root, "alien.zip");
      writeFileSync(alienZip, zipSync({ "pyxis.db": new Uint8Array(readFileSync(alien)) }));
      expect(() => restoreWorkspace(alienZip, workspace)).toThrow(/backup-corrupt/);

      const old = join(root, "old.db");
      const rawOld = new Database(old);
      rawOld.exec(
        `CREATE TABLE plans (id TEXT PRIMARY KEY);
         CREATE TABLE profile (id TEXT PRIMARY KEY);
         CREATE TABLE path_nodes (id TEXT PRIMARY KEY)`,
      );
      rawOld.pragma("user_version = 1");
      rawOld.close();
      const oldZip = join(root, "old.zip");
      writeFileSync(oldZip, zipSync({ "pyxis.db": new Uint8Array(readFileSync(old)) }));
      expect(() => restoreWorkspace(oldZip, workspace)).toThrow(/backup-corrupt/);
      const kept = openDatabase(join(workspace, "pyxis.db"));
      const title = kept.prepare(`SELECT title FROM plans WHERE id = ?`).get(planId) as {
        title: string;
      };
      kept.close();
      expect(title.title).toBe(originalTitle);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
