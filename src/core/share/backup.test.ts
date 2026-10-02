import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { uuidv7 } from "../../shared/ids";
import { backupWorkspace, restoreWorkspace } from "./backup";

describe("backupWorkspace / restoreWorkspace", () => {
  it("restores the exact plan list into a fresh workspace and keeps it after corruption", () => {
    const root = mkdtempSync(join(tmpdir(), "pyxis-fresh-backup-"));
    try {
      const source = join(root, "source");
      const target = join(root, "fresh");
      mkdirSync(source);
      const db = openDatabase(join(source, "pyxis.db"));
      db.prepare(
        "INSERT INTO plans (id,title,status,created_at,updated_at) VALUES (?,?,'ready',1,1)",
      ).run("p1", "Fisica");
      db.prepare(
        "INSERT INTO plans (id,title,status,created_at,updated_at) VALUES (?,?,'ready',2,2)",
      ).run("p2", "Analisi");
      const expected = db.prepare("SELECT * FROM plans ORDER BY id").all();
      db.close();
      const archive = join(root, "backup.zip");
      backupWorkspace(source, archive);
      restoreWorkspace(archive, target);
      let restored = openDatabase(join(target, "pyxis.db"));
      expect(restored.prepare("SELECT * FROM plans ORDER BY id").all()).toEqual(
        expected,
      );
      restored.close();
      writeFileSync(archive, "corrupt");
      expect(() => restoreWorkspace(archive, target)).toThrow(/backup-corrupt/);
      restored = openDatabase(join(target, "pyxis.db"));
      expect(restored.prepare("SELECT * FROM plans ORDER BY id").all()).toEqual(
        expected,
      );
      restored.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
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
      live
        .prepare(`UPDATE plans SET title = ? WHERE id = ?`)
        .run("Mutated", planId);
      live.close();

      restoreWorkspace(zipPath, workspace);

      const restored = openDatabase(join(workspace, "pyxis.db"));
      const row = restored
        .prepare(`SELECT title FROM plans WHERE id = ?`)
        .get(planId) as { title: string };
      restored.close();
      expect(row.title).toBe(originalTitle);

      writeFileSync(fakeZip, randomBytes(8));
      expect(() => restoreWorkspace(fakeZip, workspace)).toThrow(
        /backup-corrupt/,
      );

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
      writeFileSync(
        alienZip,
        zipSync({ "pyxis.db": new Uint8Array(readFileSync(alien)) }),
      );
      expect(() => restoreWorkspace(alienZip, workspace)).toThrow(
        /backup-corrupt/,
      );

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
      writeFileSync(
        oldZip,
        zipSync({ "pyxis.db": new Uint8Array(readFileSync(old)) }),
      );
      expect(() => restoreWorkspace(oldZip, workspace)).toThrow(
        /backup-corrupt/,
      );
      const kept = openDatabase(join(workspace, "pyxis.db"));
      const title = kept
        .prepare(`SELECT title FROM plans WHERE id = ?`)
        .get(planId) as {
        title: string;
      };
      kept.close();
      expect(title.title).toBe(originalTitle);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
