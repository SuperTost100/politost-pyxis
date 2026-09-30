// ponytail: zip holds the vacuumed db and blob files; no write lock across processes. Upgrade path is the plan's staged swap that waits until core restarts.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import Database from "better-sqlite3";
import { zipSync, unzipSync } from "fflate";
import { openDatabase } from "../db/connection";

const CORRUPT = "backup-corrupt";

function corrupt(): never {
  throw new Error(CORRUPT);
}

function isPyxisBackup(file: string): boolean {
  let db: Database.Database;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return false;
  }
  try {
    const version = Number(db.pragma("user_version", { simple: true }));
    if (!Number.isFinite(version) || version < 1) return false;
    const names = new Set(
      (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    return names.has("plans") && names.has("profile") && names.has("path_nodes");
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function isZipPathUnsafe(name: string): boolean {
  if (name.startsWith("/") || name.startsWith("\\")) return true;
  if (/^[a-zA-Z]:/.test(name)) return true;
  const parts = name.split(/[/\\]/);
  return parts.some((p) => p === "..");
}

function vacuumInto(db: Database.Database, dest: string): void {
  try {
    db.prepare("VACUUM INTO ?").run(dest);
  } catch {
    const quoted = `'${dest.replace(/'/g, "''")}'`;
    db.exec(`VACUUM INTO ${quoted}`);
  }
}

function collectBlobEntries(workspace: string): Record<string, Uint8Array> {
  const blobsRoot = join(workspace, "blobs");
  const out: Record<string, Uint8Array> = {};
  if (!existsSync(blobsRoot)) return out;

  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(workspace, full).split(sep).join("/");
        out[rel] = new Uint8Array(readFileSync(full));
      }
    }
  };
  walk(blobsRoot);
  return out;
}

function removeTree(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

export function backupWorkspace(workspace: string, destZip: string): void {
  const dbPath = join(workspace, "pyxis.db");
  const db = openDatabase(dbPath);
  const tempDb = join(dirname(destZip), `${basename(destZip)}.vacuum.tmp`);
  vacuumInto(db, tempDb);
  db.close();

  const zipEntries: Record<string, Uint8Array> = {
    "pyxis.db": new Uint8Array(readFileSync(tempDb)),
    ...collectBlobEntries(workspace),
  };
  writeFileSync(destZip, zipSync(zipEntries));
  removeTree(tempDb);
}

export function restoreWorkspace(zipPath: string, workspace: string): void {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(zipPath));
  } catch {
    corrupt();
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    corrupt();
  }

  const names = Object.keys(entries);
  if (!names.includes("pyxis.db")) corrupt();
  for (const name of names) {
    if (isZipPathUnsafe(name)) corrupt();
  }

  const staging = `${workspace}.restore`;
  removeTree(staging);
  mkdirSync(staging, { recursive: true });

  for (const [name, data] of Object.entries(entries)) {
    const dest = join(staging, ...name.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
  }

  const stagedDb = join(staging, "pyxis.db");
  if (!isPyxisBackup(stagedDb)) {
    removeTree(staging);
    corrupt();
  }
  try {
    const db = openDatabase(stagedDb);
    db.close();
  } catch {
    removeTree(staging);
    corrupt();
  }

  const oldPath = `${workspace}.old`;
  removeTree(oldPath);
  const hadLive = existsSync(workspace);
  if (hadLive) renameSync(workspace, oldPath);
  try {
    renameSync(staging, workspace);
  } catch (e) {
    if (hadLive && existsSync(oldPath)) renameSync(oldPath, workspace);
    removeTree(staging);
    throw e;
  }
  if (hadLive) removeTree(oldPath);
}
