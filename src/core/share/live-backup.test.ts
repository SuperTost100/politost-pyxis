import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { backupWorkspace, hasActiveJobs, restoreWorkspace } from "./backup";

const hooks = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((path: string) => void),
  afterLstat: undefined as undefined | ((path: string) => void),
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      hooks.beforeOpen?.(String(args[0]));
      return fs.openSync(...args);
    },
    lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => {
      const info = fs.lstatSync(...args);
      hooks.afterLstat?.(String(args[0]));
      return info;
    }) as typeof fs.lstatSync,
  };
});
afterEach(() => {
  hooks.beforeOpen = undefined;
  hooks.afterLstat = undefined;
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "pyxis-live-backup-"));
  const source = join(root, "source");
  mkdirSync(join(source, "blobs"), { recursive: true });
  openDatabase(join(source, "pyxis.db")).close();
  return { root, source, archive: join(root, "backup.zip") };
}

function putBlob(workspace: string, bytes: Uint8Array): string {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const dir = join(workspace, "blobs", sha.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sha), bytes);
  writeFileSync(
    join(dir, `${sha}.json`),
    JSON.stringify({ mime: "text/plain", ext: "txt" }),
  );
  return sha;
}

function blobPath(workspace: string, sha: string): string {
  return join(workspace, "blobs", sha.slice(0, 2), sha);
}

function archived(archive: string): string[] {
  return Object.keys(unzipSync(new Uint8Array(readFileSync(archive)))).sort();
}

const require = createRequire(import.meta.url);

/**
 * Core's write pattern, in another thread: a blob file is published, then one transaction adds a source that uses it,
 * a plan linked to it and the plan count. With deletes switched on, every fifth round also deletes an earlier source,
 * commits, then removes its blob, like a deleted chat. Runs until told to stop.
 */
const writerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require(workerData.sqlite);
const db = new Database(path.join(workerData.workspace, "pyxis.db"));
db.pragma("busy_timeout = 10000");
const stop = new Int32Array(workerData.stop);
const write = (file, bytes) => {
  const temporary = path.join(path.dirname(file), "." + path.basename(file) + "." + crypto.randomUUID() + ".tmp");
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, file);
};
let round = 0;
const add = db.transaction((id, sha) => {
  db.prepare("INSERT INTO sources (id,kind,title,blob_sha,status,created_at,updated_at) VALUES (?,'text',?,?,'ready',1,1)").run(id, id, sha);
  db.prepare("INSERT INTO plans (id,title,status,created_at,updated_at) VALUES (?,?,'ready',1,1)").run(id, id);
  db.prepare("INSERT INTO plan_sources (plan_id,source_id) VALUES (?,?)").run(id, id);
  db.prepare("INSERT INTO settings (key,value_json,updated_at) VALUES ('count',?,1) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(String(db.prepare("SELECT count(*) AS n FROM plans").get().n));
});
const remove = db.transaction((id) => {
  db.prepare("DELETE FROM plans WHERE id = ?").run(id);
  db.prepare("DELETE FROM sources WHERE id = ?").run(id);
  db.prepare("UPDATE settings SET value_json = ? WHERE key = 'count'")
    .run(String(db.prepare("SELECT count(*) AS n FROM plans").get().n));
});
while (Atomics.load(stop, 0) === 0) {
  if (Atomics.load(stop, 4) === 1) {
    Atomics.wait(stop, 3, 0, 5);
    continue;
  }
  round += 1;
  const id = "w" + String(round).padStart(6, "0");
  const bytes = Buffer.from(id + " ".repeat(2000) + Math.random());
  const sha = createHash("sha256").update(bytes).digest("hex");
  const dir = path.join(workerData.workspace, "blobs", sha.slice(0, 2));
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, sha), bytes);
  write(path.join(dir, sha + ".json"), JSON.stringify({ mime: "text/plain", ext: "txt" }));
  add(id, sha);
  if (Atomics.load(stop, 2) === 1 && round % 5 === 0) {
    const old = db.prepare("SELECT id, blob_sha FROM sources ORDER BY random() LIMIT 1").get();
    remove(old.id);
    fs.rmSync(path.join(workerData.workspace, "blobs", old.blob_sha.slice(0, 2), old.blob_sha), { force: true });
    fs.rmSync(path.join(workerData.workspace, "blobs", old.blob_sha.slice(0, 2), old.blob_sha + ".json"), { force: true });
  }
  Atomics.store(stop, 1, round);
  // About one write every two milliseconds: busy, but the workspace stays far below the backup's file limit.
  Atomics.wait(stop, 3, 0, 2);
}
db.close();
parentPort.postMessage("stopped");
`;

describe("live backup", { timeout: 60_000 }, () => {
  it("copies a consistent state while another connection keeps writing, and the copy restores", async () => {
    const w = workspace();
    // [stop, rounds written, deletes on, a slot the writer sleeps on, paused]
    const stop = new SharedArrayBuffer(20);
    const flags = new Int32Array(stop);
    const writer = new Worker(writerSource, {
      eval: true,
      workerData: {
        workspace: w.source,
        stop,
        sqlite: require.resolve("better-sqlite3"),
      },
    });
    try {
      // Let the writer build up a workspace first, so each copy takes long enough to overlap with its writes.
      await vi.waitFor(
        () => expect(Atomics.load(flags, 1)).toBeGreaterThan(150),
        {
          timeout: 30_000,
        },
      );
      // Phase one: core only adds, until two copies overlapped its commits. Phase two: core also deletes sources and
      // their blobs, until a copy runs into a deletion. Each phase gives up after six copies.
      let copies = 0;
      let changed = 0;
      let deleting = false;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        if (!deleting && (copies >= 2 || attempt === 6)) {
          deleting = true;
          Atomics.store(flags, 2, 1);
        }
        if (deleting && changed > 0) break;
        Atomics.store(flags, 4, 0);
        const before = Atomics.load(flags, 1);
        const archive = join(w.root, `copy-${attempt}.zip`);
        try {
          backupWorkspace(w.source, archive, { live: true });
        } catch (error) {
          // The writer deleted a blob the snapshot used; the scheduler tries again later. Anything else is a bug.
          expect((error as Error).message).toBe("backup-changed");
          expect(deleting).toBe(true);
          changed += 1;
          continue;
        }
        const during = Atomics.load(flags, 1) - before;
        // Checking the copy is slow; the workspace should not grow meanwhile.
        Atomics.store(flags, 4, 1);
        const target = join(w.root, `restored-${attempt}`);
        restoreWorkspace(archive, target);
        const db = openDatabase(join(target, "pyxis.db"));
        try {
          expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
          expect(db.pragma("foreign_key_check")).toEqual([]);
          const plans = (
            db.prepare("SELECT count(*) AS n FROM plans").get() as { n: number }
          ).n;
          const count = db
            .prepare("SELECT value_json FROM settings WHERE key = 'count'")
            .get() as { value_json: string };
          // One transaction writes the plan, its source, the link and the count: a torn copy would disagree.
          expect(Number(count.value_json)).toBe(plans);
          expect(
            (
              db
                .prepare(
                  "SELECT count(*) AS n FROM plans p LEFT JOIN plan_sources ps ON ps.plan_id = p.id WHERE ps.source_id IS NULL",
                )
                .get() as { n: number }
            ).n,
          ).toBe(0);
          const shas = (
            db.prepare("SELECT blob_sha FROM sources").all() as Array<{
              blob_sha: string;
            }>
          ).map((row) => row.blob_sha);
          expect(shas.length).toBe(plans);
          for (const sha of shas)
            expect(existsSync(blobPath(target, sha))).toBe(true);
        } finally {
          db.close();
        }
        if (during > 0 && !deleting) copies += 1;
        rmSync(archive);
        rmSync(target, { recursive: true });
      }
      // Copies were taken while the writer committed in the middle of them, and every one restored consistently.
      expect(copies).toBe(2);
      // The deleting phase hit the race the copy has to detect.
      expect(changed).toBeGreaterThan(0);
    } finally {
      Atomics.store(flags, 0, 1);
      await new Promise((resolve) => writer.once("exit", resolve));
      rmSync(w.root, { recursive: true, force: true });
    }
  });

  it("leaves out a transaction that is still open, without waiting for it", () => {
    const w = workspace();
    const writer = openDatabase(join(w.source, "pyxis.db"));
    try {
      writer
        .prepare(
          "INSERT INTO plans (id,title,status,created_at,updated_at) VALUES ('kept','Kept','ready',1,1)",
        )
        .run();
      writer.exec("BEGIN IMMEDIATE");
      writer
        .prepare(
          "INSERT INTO plans (id,title,status,created_at,updated_at) VALUES ('open','Open','ready',1,1)",
        )
        .run();
      backupWorkspace(w.source, w.archive, { live: true });
      writer.exec("COMMIT");
      const target = join(w.root, "restored");
      restoreWorkspace(w.archive, target);
      const db = openDatabase(join(target, "pyxis.db"));
      expect(db.prepare("SELECT id FROM plans").all()).toEqual([
        { id: "kept" },
      ]);
      db.close();
    } finally {
      writer.close();
      rmSync(w.root, { recursive: true, force: true });
    }
  });

  it("stops with backup-changed when core deletes a blob the snapshot uses", () => {
    const w = workspace();
    const sha = putBlob(w.source, Buffer.from("used by the snapshot"));
    const db = openDatabase(join(w.source, "pyxis.db"));
    db.prepare(
      "INSERT INTO sources (id,kind,title,blob_sha,status,created_at,updated_at) VALUES ('s','text','S',?,'ready',1,1)",
    ).run(sha);
    try {
      hooks.beforeOpen = (path) => {
        if (path !== blobPath(w.source, sha)) return;
        hooks.beforeOpen = undefined;
        // What a chat delete does after the snapshot: the row goes, then its unused file.
        db.prepare("DELETE FROM sources WHERE id = 's'").run();
        rmSync(path);
        rmSync(`${path}.json`);
      };
      expect(() =>
        backupWorkspace(w.source, w.archive, { live: true }),
      ).toThrow("backup-changed");
      expect(existsSync(w.archive)).toBe(false);
      expect(readdirSync(w.root).sort()).toEqual(["source"]);
    } finally {
      db.close();
      rmSync(w.root, { recursive: true, force: true });
    }
  });

  it("stops with backup-changed when core deletes a used blob right after the listing saw it", () => {
    const w = workspace();
    const sha = putBlob(w.source, Buffer.from("listed, then deleted"));
    const db = openDatabase(join(w.source, "pyxis.db"));
    db.prepare(
      "INSERT INTO sources (id,kind,title,blob_sha,status,created_at,updated_at) VALUES ('s','text','S',?,'ready',1,1)",
    ).run(sha);
    try {
      // After the listing the copy measures the snapshot; delete the blob then, before it is opened or measured.
      hooks.afterLstat = (path) => {
        if (!path.endsWith("pyxis.db") || path.startsWith(w.source)) return;
        hooks.afterLstat = undefined;
        db.prepare("DELETE FROM sources WHERE id = 's'").run();
        rmSync(blobPath(w.source, sha));
        rmSync(`${blobPath(w.source, sha)}.json`);
      };
      expect(() =>
        backupWorkspace(w.source, w.archive, { live: true }),
      ).toThrow("backup-changed");
      expect(existsSync(w.archive)).toBe(false);
    } finally {
      db.close();
      rmSync(w.root, { recursive: true, force: true });
    }
  });

  it("stops with backup-changed when a used blob was deleted before the listing", () => {
    const w = workspace();
    const sha = putBlob(w.source, Buffer.from("gone before the walk"));
    const db = openDatabase(join(w.source, "pyxis.db"));
    db.prepare(
      "INSERT INTO sources (id,kind,title,blob_sha,status,created_at,updated_at) VALUES ('s','text','S',?,'ready',1,1)",
    ).run(sha);
    try {
      // The first stop check runs right after the snapshot and before the blob listing: delete there.
      let deleted = false;
      const deleteOnce = () => {
        if (deleted) return false;
        deleted = true;
        db.prepare("DELETE FROM sources WHERE id = 's'").run();
        rmSync(blobPath(w.source, sha));
        rmSync(`${blobPath(w.source, sha)}.json`);
        return false;
      };
      expect(() =>
        backupWorkspace(w.source, w.archive, {
          live: true,
          stopped: deleteOnce,
        }),
      ).toThrow("backup-changed");
      expect(deleted).toBe(true);
    } finally {
      db.close();
      rmSync(w.root, { recursive: true, force: true });
    }
  });

  it("copies a workspace whose used blob was already missing, as a manual backup does", () => {
    const w = workspace();
    const db = openDatabase(join(w.source, "pyxis.db"));
    db.prepare(
      "INSERT INTO sources (id,kind,title,blob_sha,status,created_at,updated_at) VALUES ('s','text','S',?,'ready',1,1)",
    ).run("a".repeat(64));
    db.close();
    try {
      backupWorkspace(w.source, w.archive, { live: true });
      expect(archived(w.archive)).toEqual(["pyxis.db"]);
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  });

  it("leaves out an unused blob that is still being written or was deleted after the listing", () => {
    const w = workspace();
    const writing = putBlob(w.source, Buffer.from("metadata not written yet"));
    rmSync(`${blobPath(w.source, writing)}.json`);
    const vanishing = putBlob(
      w.source,
      Buffer.from("deleted after the listing"),
    );
    const kept = putBlob(w.source, Buffer.from("kept"));
    try {
      hooks.beforeOpen = (path) => {
        if (path !== blobPath(w.source, vanishing)) return;
        rmSync(path);
        rmSync(`${path}.json`);
      };
      backupWorkspace(w.source, w.archive, { live: true });
      const names = archived(w.archive);
      expect(names).toContain(`blobs/${kept.slice(0, 2)}/${kept}`);
      expect(names).toContain(`blobs/${kept.slice(0, 2)}/${kept}.json`);
      expect(names.some((name) => name.includes(writing))).toBe(false);
      expect(names.some((name) => name.includes(vanishing))).toBe(false);
      // The unfinished blob stays where core is writing it.
      expect(existsSync(blobPath(w.source, writing))).toBe(true);
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  });

  it("stops when asked, without leaving an archive or its temporary folder", () => {
    const w = workspace();
    putBlob(w.source, Buffer.from("one"));
    try {
      let temporary = "";
      expect(() =>
        backupWorkspace(w.source, w.archive, {
          live: true,
          stopped: () => true,
          onTemporary: (path) => {
            temporary = path;
          },
        }),
      ).toThrow("backup-cancelled");
      expect(temporary).not.toBe("");
      expect(existsSync(temporary)).toBe(false);
      expect(existsSync(w.archive)).toBe(false);
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  });

  it("sees queued and running jobs, not finished ones", () => {
    const w = workspace();
    const db = openDatabase(join(w.source, "pyxis.db"));
    try {
      const add = db.prepare(
        "INSERT INTO jobs (id,kind,state,created_at,updated_at) VALUES (?,'extract',?,1,1)",
      );
      add.run("done", "succeeded");
      add.run("stopped", "interrupted");
      expect(hasActiveJobs(w.source)).toBe(false);
      add.run("waiting", "queued");
      expect(hasActiveJobs(w.source)).toBe(true);
      db.prepare(
        "UPDATE jobs SET state = 'running' WHERE id = 'waiting'",
      ).run();
      expect(hasActiveJobs(w.source)).toBe(true);
      db.prepare("UPDATE jobs SET state = 'failed' WHERE id = 'waiting'").run();
      expect(hasActiveJobs(w.source)).toBe(false);
    } finally {
      db.close();
      rmSync(w.root, { recursive: true, force: true });
    }
  });
});
