import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  renameSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { uuidv7 } from "../../shared/ids";
import {
  backupWorkspace,
  restoreWorkspace,
  recoverInterruptedRestore,
  commitWorkspaceRestore,
} from "./backup";

const removal = vi.hoisted(() => ({
  before: undefined as undefined | ((path: string) => void),
  beforeOpen: undefined as undefined | ((path: string) => void),
  failJournalWrite: false,
  largeInodes: false,
  opened: new Map<number, string>(),
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      const info = fs.lstatSync(...args);
      if (removal.largeInodes && args[1]?.bigint && info?.isDirectory()) {
        (info as import("node:fs").BigIntStats).ino += 2n ** 60n;
      }
      return info;
    },
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      removal.beforeOpen?.(String(args[0]));
      const fd = fs.openSync(...args);
      removal.opened.set(fd, String(args[0]));
      return fd;
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (
        removal.failJournalWrite &&
        typeof args[0] === "number" &&
        removal.opened.get(args[0])?.endsWith(".restore-journal.json.tmp")
      ) {
        removal.failJournalWrite = false;
        fs.writeFileSync(args[0], '{"partial"');
        throw new Error("journal-write-interrupted");
      }
      return fs.writeFileSync(...args);
    },
    rmSync: (
      path: Parameters<typeof fs.rmSync>[0],
      options: Parameters<typeof fs.rmSync>[1],
    ) => {
      removal.before?.(String(path));
      return fs.rmSync(path, options);
    },
  };
});
afterEach(() => {
  removal.before = undefined;
  removal.beforeOpen = undefined;
  removal.failJournalWrite = false;
  removal.largeInodes = false;
  removal.opened.clear();
});

// Windows runners scan every file a test creates, so a case that takes 0.1 s locally can pass 5 s there.
describe("backupWorkspace / restoreWorkspace", { timeout: 30_000 }, () => {
  it("roundtrips restore identities larger than a JavaScript safe integer", () => {
    const root = mkdtempSync(join(tmpdir(), "pyxis-large-inode-"));
    try {
      const source = join(root, "source"), target = join(root, "target"), archive = join(root, "backup.zip");
      mkdirSync(source); mkdirSync(target);
      const db = openDatabase(join(source, "pyxis.db")); db.close();
      const old = openDatabase(join(target, "pyxis.db")); old.close();
      backupWorkspace(source, archive);
      removal.largeInodes = true;
      restoreWorkspace(archive, target, { deferCommit: true });
      const journal = JSON.parse(readFileSync(`${target}.restore-journal.json`, "utf8"));
      expect(typeof journal.staged.ino).toBe("string");
      expect(BigInt(journal.staged.ino)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
      expect(commitWorkspaceRestore(target)).toBe(true);
      expect(existsSync(`${target}.old`)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
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

describe("restore validation and interruption recovery", { timeout: 30_000 }, () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "pyxis-safe-restore-"));
    const source = join(root, "source");
    const live = join(root, "live");
    const archive = join(root, "backup.zip");
    for (const [path, title] of [
      [source, "Backup"],
      [live, "Original"],
    ] as const) {
      mkdirSync(path);
      const db = openDatabase(join(path, "pyxis.db"));
      db.prepare(
        "INSERT INTO plans (id,title,status,created_at,updated_at) VALUES ('p',?,'ready',1,1)",
      ).run(title);
      db.close();
    }
    return { root, source, live, archive };
  }
  function title(path: string) {
    const db = openDatabase(join(path, "pyxis.db"));
    try {
      return (
        db.prepare("SELECT title FROM plans WHERE id='p'").get() as {
          title: string;
        }
      ).title;
    } finally {
      db.close();
    }
  }
  function archiveDatabase(source: string, archive: string) {
    writeFileSync(
      archive,
      zipSync({
        "pyxis.db": new Uint8Array(readFileSync(join(source, "pyxis.db"))),
      }),
    );
  }

  it("keeps an existing backup and unrelated old temporary file when backup creation fails", () => {
    const f = fixture();
    try {
      writeFileSync(f.archive, "previous backup");
      writeFileSync(`${f.archive}.vacuum.tmp`, "unrelated saved file");
      writeFileSync(join(f.source, "blobs"), "not a directory");
      expect(() => backupWorkspace(f.source, f.archive)).toThrow(
        "backup-restore-unsafe-path",
      );
      expect(readFileSync(f.archive, "utf8")).toBe("previous backup");
      expect(readFileSync(`${f.archive}.vacuum.tmp`, "utf8")).toBe(
        "unrelated saved file",
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("validates canonical blob names, hashes and metadata before swapping", () => {
    const f = fixture();
    try {
      const bytes = Buffer.from("source bytes");
      const sha = createHash("sha256").update(bytes).digest("hex");
      const name = `blobs/${sha.slice(0, 2)}/${sha}`;
      const meta = Buffer.from(
        JSON.stringify({ mime: "text/plain", ext: "txt" }),
      );
      const db = readFileSync(join(f.source, "pyxis.db"));
      const invalidEntries: Array<Record<string, Uint8Array>> = [
        { [name]: Buffer.from("tampered"), [`${name}.json`]: meta },
        { [name]: bytes },
        { [name]: bytes, [`${name}.json`]: Buffer.from('{"mime":') },
        { [name]: bytes, [`${name}.json`]: meta, "runtimes/payload.js": bytes },
        { [`blobs/ff/${sha}`]: bytes },
      ];
      for (const extra of invalidEntries) {
        writeFileSync(f.archive, zipSync({ "pyxis.db": db, ...extra }));
        expect(() => restoreWorkspace(f.archive, f.live)).toThrow(
          "backup-corrupt",
        );
        expect(title(f.live)).toBe("Original");
      }
      writeFileSync(
        f.archive,
        zipSync({ "pyxis.db": db, [name]: bytes, [`${name}.json`]: meta }),
      );
      restoreWorkspace(f.archive, f.live);
      expect(title(f.live)).toBe("Backup");
      expect(readFileSync(join(f.live, ...name.split("/")))).toEqual(bytes);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("preserves existing runtime/model caches while restoring study data", () => {
    const f = fixture();
    try {
      mkdirSync(join(f.live, "runtimes", "python"), { recursive: true });
      mkdirSync(join(f.live, "models", "embedding"), { recursive: true });
      writeFileSync(
        join(f.live, "runtimes", "python", "runtime.wasm"),
        "verified cached runtime",
      );
      writeFileSync(
        join(f.live, "models", "embedding", "weights.bin"),
        "verified cached model",
      );
      backupWorkspace(f.source, f.archive);
      restoreWorkspace(f.archive, f.live, { deferCommit: true });
      expect(
        readFileSync(
          join(f.live, "runtimes", "python", "runtime.wasm"),
          "utf8",
        ),
      ).toBe("verified cached runtime");
      recoverInterruptedRestore(f.live);
      expect(
        readFileSync(
          join(f.live, "models", "embedding", "weights.bin"),
          "utf8",
        ),
      ).toBe("verified cached model");
      restoreWorkspace(f.archive, f.live);
      expect(
        readFileSync(
          join(f.live, "runtimes", "python", "runtime.wasm"),
          "utf8",
        ),
      ).toBe("verified cached runtime");
      expect(title(f.live)).toBe("Backup");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rejects foreign-key violations before modifying the live workspace", () => {
    const f = fixture();
    try {
      const db = openDatabase(join(f.source, "pyxis.db"));
      db.pragma("foreign_keys = OFF");
      db.prepare(
        "INSERT INTO plan_sources (plan_id,source_id) VALUES ('p','missing-source')",
      ).run();
      db.close();
      archiveDatabase(f.source, f.archive);
      expect(() => restoreWorkspace(f.archive, f.live)).toThrow(
        "backup-corrupt",
      );
      expect(title(f.live)).toBe("Original");
      expect(existsSync(`${f.live}.old`)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rejects structurally readable database pages with failed integrity checks", () => {
    const f = fixture();
    try {
      const db = openDatabase(join(f.source, "pyxis.db"));
      db.exec(
        "CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO probe VALUES (1,'check');",
      );
      const page = (
        db
          .prepare("SELECT rootpage FROM sqlite_master WHERE name='probe'")
          .get() as { rootpage: number }
      ).rootpage;
      const pageSize = Number(db.pragma("page_size", { simple: true }));
      db.close();
      const bytes = readFileSync(join(f.source, "pyxis.db"));
      bytes[(page - 1) * pageSize] = 0;
      writeFileSync(join(f.source, "pyxis.db"), bytes);
      archiveDatabase(f.source, f.archive);
      expect(() => restoreWorkspace(f.archive, f.live)).toThrow(
        "backup-corrupt",
      );
      expect(title(f.live)).toBe("Original");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rejects future schemas without overwriting current data", () => {
    const f = fixture();
    try {
      const db = openDatabase(join(f.source, "pyxis.db"));
      db.pragma("user_version = 1000");
      db.close();
      archiveDatabase(f.source, f.archive);
      expect(() => restoreWorkspace(f.archive, f.live)).toThrow(
        "backup-corrupt",
      );
      expect(title(f.live)).toBe("Original");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("keeps the old copy until readiness and recovers an uncommitted promotion", () => {
    const f = fixture();
    try {
      backupWorkspace(f.source, f.archive);
      restoreWorkspace(f.archive, f.live, { deferCommit: true });
      expect(title(f.live)).toBe("Backup");
      expect(title(`${f.live}.old`)).toBe("Original");
      recoverInterruptedRestore(f.live);
      expect(title(f.live)).toBe("Original");
      expect(existsSync(`${f.live}.restore-journal.json`)).toBe(false);
      expect(existsSync(`${f.live}.restore`)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("recovers the crash window between moving old and promoting staging", () => {
    const f = fixture();
    try {
      backupWorkspace(f.source, f.archive);
      restoreWorkspace(f.archive, f.live, { deferCommit: true });
      renameSync(f.live, `${f.live}.restore`);
      const journal = `${f.live}.restore-journal.json`;
      const record = JSON.parse(readFileSync(journal, "utf8"));
      writeFileSync(journal, JSON.stringify({ ...record, phase: "prepared" }));
      recoverInterruptedRestore(f.live);
      expect(title(f.live)).toBe("Original");
      expect(existsSync(`${f.live}.old`)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("commits a ready restore and never selects partially deleted old data", () => {
    const f = fixture();
    try {
      backupWorkspace(f.source, f.archive);
      restoreWorkspace(f.archive, f.live, { deferCommit: true });
      const journal = `${f.live}.restore-journal.json`;
      const record = JSON.parse(readFileSync(journal, "utf8"));
      writeFileSync(journal, JSON.stringify({ ...record, phase: "committed" }));
      rmSync(join(`${f.live}.old`, "pyxis.db"));
      recoverInterruptedRestore(f.live);
      expect(title(f.live)).toBe("Backup");
      expect(existsSync(`${f.live}.old`)).toBe(false);
      restoreWorkspace(f.archive, f.live, { deferCommit: true });
      expect(commitWorkspaceRestore(f.live)).toBe(true);
      expect(title(f.live)).toBe("Backup");
      expect(existsSync(`${f.live}.old`)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("retains a committed journal after partial cleanup failure and keeps the new copy", () => {
    const f = fixture();
    try {
      backupWorkspace(f.source, f.archive);
      restoreWorkspace(f.archive, f.live, { deferCommit: true });
      removal.before = (path) => {
        if (path !== `${f.live}.old`) return;
        rmSync(join(path, "pyxis.db"));
        throw new Error("disk-cleanup-failed");
      };
      expect(commitWorkspaceRestore(f.live)).toBe(false);
      expect(title(f.live)).toBe("Backup");
      expect(
        JSON.parse(readFileSync(`${f.live}.restore-journal.json`, "utf8"))
          .phase,
      ).toBe("committed");
      removal.before = undefined;
      recoverInterruptedRestore(f.live);
      expect(title(f.live)).toBe("Backup");
      expect(existsSync(`${f.live}.old`)).toBe(false);
    } finally {
      removal.before = undefined;
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rolls back promotion even if a crash prevented writing the promoted phase", () => {
    const f = fixture();
    try {
      backupWorkspace(f.source, f.archive);
      restoreWorkspace(f.archive, f.live, { deferCommit: true });
      const journal = `${f.live}.restore-journal.json`;
      const record = JSON.parse(readFileSync(journal, "utf8"));
      writeFileSync(journal, JSON.stringify({ ...record, phase: "prepared" }));
      recoverInterruptedRestore(f.live);
      expect(title(f.live)).toBe("Original");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("preserves both copies and stops recovery when a directory has been replaced", () => {
    const f = fixture();
    try {
      backupWorkspace(f.source, f.archive);
      restoreWorkspace(f.archive, f.live, { deferCommit: true });
      renameSync(f.live, join(f.root, "saved-backup"));
      mkdirSync(f.live);
      writeFileSync(join(f.live, "foreign"), "keep");
      expect(() => recoverInterruptedRestore(f.live)).toThrow(
        "backup-restore-recovery-required",
      );
      expect(readFileSync(join(f.live, "foreign"), "utf8")).toBe("keep");
      expect(title(`${f.live}.old`)).toBe("Original");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rejects unjournalled old copies and unexpected archive paths", () => {
    const f = fixture();
    try {
      backupWorkspace(f.source, f.archive);
      mkdirSync(`${f.live}.old`);
      writeFileSync(join(`${f.live}.old`, "keep"), "saved");
      expect(() => restoreWorkspace(f.archive, f.live)).toThrow(
        "backup-restore-recovery-required",
      );
      expect(readFileSync(join(`${f.live}.old`, "keep"), "utf8")).toBe("saved");
      rmSync(`${f.live}.old`, { recursive: true });
      const valid = readFileSync(join(f.source, "pyxis.db"));
      for (const name of [
        "../escape",
        "blobs/x:alternate",
        "blobs/../pyxis.db",
        "keys.json",
      ]) {
        writeFileSync(
          f.archive,
          zipSync({ "pyxis.db": valid, [name]: new Uint8Array([1]) }),
        );
        expect(() => restoreWorkspace(f.archive, f.live)).toThrow(
          "backup-corrupt",
        );
      }
      expect(title(f.live)).toBe("Original");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  function addBlob(workspace: string, bytes: Uint8Array) {
    const sha = createHash("sha256").update(bytes).digest("hex");
    const dir = join(workspace, "blobs", sha.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, sha), bytes);
    writeFileSync(
      join(dir, `${sha}.json`),
      JSON.stringify({ mime: "application/octet-stream", ext: "bin" }),
    );
    return { sha, dir };
  }
  function centralHeader(zip: Buffer, name: string): number {
    const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    for (
      let i = zip.indexOf(signature);
      i >= 0;
      i = zip.indexOf(signature, i + 1)
    )
      if (
        zip.subarray(i + 46, i + 46 + zip.readUInt16LE(i + 28)).toString() ===
        name
      )
        return i;
    throw new Error(`no central header for ${name}`);
  }
  function expectRejected(f: ReturnType<typeof fixture>, zip: Uint8Array) {
    writeFileSync(f.archive, zip);
    expect(() => restoreWorkspace(f.archive, f.live)).toThrow("backup-corrupt");
    expect(title(f.live)).toBe("Original");
    expect(existsSync(`${f.live}.old`)).toBe(false);
  }

  it("streams multi-chunk blobs through backup and restore byte for byte", () => {
    const f = fixture();
    try {
      // Incompressible data spans many read chunks; zeros expand 1000x per inflate chunk.
      const random = new Uint8Array(randomBytes(3 * 1024 * 1024 + 17));
      const zeros = new Uint8Array(6 * 1024 * 1024);
      const first = addBlob(f.source, random);
      const second = addBlob(f.source, zeros);
      backupWorkspace(f.source, f.archive);
      expect(
        readdirSync(f.root).some((n) => n.startsWith(".pyxis-backup-")),
      ).toBe(false);
      const names = Object.keys(unzipSync(readFileSync(f.archive)));
      expect(names).toContain(
        `blobs/${first.sha.slice(0, 2)}/${first.sha}.json`,
      );
      restoreWorkspace(f.archive, f.live);
      expect(title(f.live)).toBe("Backup");
      expect(
        readFileSync(
          join(f.live, "blobs", first.sha.slice(0, 2), first.sha),
        ).equals(Buffer.from(random)),
      ).toBe(true);
      expect(
        readFileSync(
          join(f.live, "blobs", second.sha.slice(0, 2), second.sha),
        ).equals(Buffer.from(zeros)),
      ).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("skips Finder bookkeeping in blobs without deleting it", () => {
    const f = fixture();
    try {
      const { dir } = addBlob(f.source, new Uint8Array([1, 2, 3]));
      writeFileSync(join(f.source, "blobs", ".DS_Store"), "x");
      writeFileSync(join(dir, "._junk"), "x");
      backupWorkspace(f.source, f.archive);
      const names = Object.keys(unzipSync(readFileSync(f.archive)));
      expect(
        names.some((n) => n.includes(".DS_Store") || n.includes("._")),
      ).toBe(false);
      expect(existsSync(join(f.source, "blobs", ".DS_Store"))).toBe(true);
      expect(existsSync(join(dir, "._junk"))).toBe(true);
      writeFileSync(join(dir, "foreign.txt"), "x");
      writeFileSync(f.archive, "previous");
      expect(() => backupWorkspace(f.source, f.archive)).toThrow(
        "backup-corrupt",
      );
      expect(readFileSync(f.archive, "utf8")).toBe("previous");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("fails backup atomically when a blob no longer matches its hash", () => {
    const f = fixture();
    try {
      const { dir, sha } = addBlob(f.source, new Uint8Array([9, 9, 9]));
      writeFileSync(join(dir, sha), "tampered");
      writeFileSync(f.archive, "previous");
      expect(() => backupWorkspace(f.source, f.archive)).toThrow(
        "backup-corrupt",
      );
      expect(readFileSync(f.archive, "utf8")).toBe("previous");
      expect(
        readdirSync(f.root).some((n) => n.startsWith(".pyxis-backup-")),
      ).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rejects oversized and dishonest headers before or during extraction", () => {
    const f = fixture();
    try {
      backupWorkspace(f.source, f.archive);
      const good = readFileSync(f.archive);
      const header = centralHeader(good, "pyxis.db");
      const huge = Buffer.from(good);
      huge.writeUInt32LE(0x80000001, header + 24);
      expectRejected(f, huge);
      expect(existsSync(`${f.live}.restore`)).toBe(false);
      // Declared size smaller than what the deflate stream really emits.
      const lying = Buffer.from(good);
      lying.writeUInt32LE(10, header + 24);
      expectRejected(f, lying);
      expect(existsSync(`${f.live}.restore`)).toBe(false);
      const larger = Buffer.from(good);
      larger.writeUInt32LE(larger.readUInt32LE(header + 24) + 1, header + 24);
      expectRejected(f, larger);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("rejects bad CRC, truncation, duplicates and garbage archives", () => {
    const f = fixture();
    try {
      backupWorkspace(f.source, f.archive);
      const good = readFileSync(f.archive);
      const crc = Buffer.from(good);
      const header = centralHeader(crc, "pyxis.db");
      crc.writeUInt32LE((crc.readUInt32LE(header + 16) ^ 1) >>> 0, header + 16);
      expectRejected(f, crc);
      expectRejected(f, good.subarray(0, good.length - 40));
      expectRejected(f, good.subarray(0, good.length >> 1));
      expectRejected(f, Buffer.alloc(100, 0x50));
      const db = new Uint8Array(readFileSync(join(f.source, "pyxis.db")));
      const a = "a".repeat(64);
      const b = "b".repeat(64);
      const dup = Buffer.from(
        zipSync({
          "pyxis.db": db,
          [`blobs/aa/${a}`]: new Uint8Array([1]),
          [`blobs/aa/${b}`]: new Uint8Array([2]),
        }),
      );
      for (let i = dup.indexOf(b); i >= 0; i = dup.indexOf(b, i + 1))
        dup.write(a, i);
      expectRejected(f, dup);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("publishes the initial journal atomically so an interrupted write leaves the original recoverable", () => {
    const f = fixture();
    try {
      backupWorkspace(f.source, f.archive);
      removal.failJournalWrite = true;
      expect(() => restoreWorkspace(f.archive, f.live)).toThrow(
        "journal-write-interrupted",
      );
      expect(title(f.live)).toBe("Original");
      expect(existsSync(`${f.live}.restore-journal.json`)).toBe(false);
      expect(readFileSync(`${f.live}.restore-journal.json.tmp`, "utf8")).toBe(
        '{"partial"',
      );
      recoverInterruptedRestore(f.live);
      expect(title(f.live)).toBe("Original");
      expect(existsSync(`${f.live}.restore-journal.json.tmp`)).toBe(false);
      restoreWorkspace(f.archive, f.live);
      expect(title(f.live)).toBe("Backup");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("normalizes malformed, non-object and oversized journal errors without deleting workspace data", () => {
    const f = fixture();
    try {
      for (const bytes of ['{"partial"', "null", "[]", " ".repeat(4097)]) {
        writeFileSync(`${f.live}.restore-journal.json`, bytes);
        expect(() => recoverInterruptedRestore(f.live)).toThrow(
          "backup-restore-journal-invalid",
        );
        expect(title(f.live)).toBe("Original");
        expect(readFileSync(`${f.live}.restore-journal.json`, "utf8")).toBe(
          bytes,
        );
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("revalidates the metadata bytes actually archived after a file changes between enumeration and streaming", () => {
    const f = fixture();
    try {
      const { dir, sha } = addBlob(f.source, new Uint8Array([1, 2, 3]));
      const metadata = join(dir, `${sha}.json`);
      writeFileSync(f.archive, "previous backup");
      removal.beforeOpen = (path) => {
        if (path === metadata) {
          removal.beforeOpen = undefined;
          writeFileSync(metadata, '{"mime":false}');
        }
      };
      expect(() => backupWorkspace(f.source, f.archive)).toThrow(
        "backup-corrupt",
      );
      expect(readFileSync(f.archive, "utf8")).toBe("previous backup");
      expect(readFileSync(metadata, "utf8")).toBe('{"mime":false}');
      expect(readFileSync(join(dir, sha))).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("preserves canonical orphan blob data and the previous archive after a crash before sidecar publication", () => {
    const f = fixture();
    try {
      const { dir, sha } = addBlob(f.source, new Uint8Array([4, 5, 6]));
      rmSync(join(dir, `${sha}.json`));
      writeFileSync(f.archive, "previous backup");
      expect(() => backupWorkspace(f.source, f.archive)).toThrow(
        "backup-corrupt",
      );
      expect(readFileSync(f.archive, "utf8")).toBe("previous backup");
      expect(readFileSync(join(dir, sha))).toEqual(Buffer.from([4, 5, 6]));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("skips only regular unpublished blob temp files and keeps them on disk", () => {
    const f = fixture();
    try {
      const { dir, sha } = addBlob(f.source, new Uint8Array([7, 8]));
      const tmpName = `.${sha}.${uuidv7()}.tmp`;
      writeFileSync(join(dir, tmpName), "partial");
      backupWorkspace(f.source, f.archive);
      expect(
        Object.keys(unzipSync(readFileSync(f.archive))).some((n) =>
          n.endsWith(".tmp"),
        ),
      ).toBe(false);
      expect(readFileSync(join(dir, tmpName), "utf8")).toBe("partial");
      rmSync(join(dir, tmpName));
      mkdirSync(join(dir, tmpName));
      writeFileSync(join(dir, tmpName, "keep"), "saved");
      writeFileSync(f.archive, "previous backup");
      expect(() => backupWorkspace(f.source, f.archive)).toThrow(
        "backup-corrupt",
      );
      expect(readFileSync(f.archive, "utf8")).toBe("previous backup");
      expect(readFileSync(join(dir, tmpName, "keep"), "utf8")).toBe("saved");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("removes a stale journal temp file but fails closed on an unsafe one", () => {
    const f = fixture();
    try {
      backupWorkspace(f.source, f.archive);
      const orphan = `${f.live}.restore-journal.json.tmp`;
      writeFileSync(orphan, '{"partial"');
      restoreWorkspace(f.archive, f.live);
      expect(title(f.live)).toBe("Backup");
      expect(existsSync(orphan)).toBe(false);
      mkdirSync(orphan);
      writeFileSync(join(orphan, "keep"), "saved");
      expect(() => restoreWorkspace(f.archive, f.live)).toThrow(
        "backup-restore-recovery-required",
      );
      expect(readFileSync(join(orphan, "keep"), "utf8")).toBe("saved");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
