import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
