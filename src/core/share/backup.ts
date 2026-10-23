import {
  existsSync,
  closeSync,
  constants as fsConstants,
  cpSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  mkdirSync,
  mkdtempSync,
  unlinkSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { getLoadablePath } from "sqlite-vec";
import { crc32 } from "node:zlib";
import { syncDirectory } from "../atomic-write";
import { blobNamed, namedBlobs } from "../blobs";
import { Inflate, Zip, ZipDeflate } from "fflate";
import { closeDatabase, openDatabase } from "../db/connection";

const CORRUPT = "backup-corrupt";
const MAX_EXPANDED = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 65_534;
const MAX_DIRECTORY = 32 * 1024 * 1024;
const MAX_META = 4096;
const IO_CHUNK = 64 * 1024;
// One deflate push can expand ~1032x before it emits, so this bounds transient memory (~16 MiB).
const INFLATE_CHUNK = 16 * 1024;

function corrupt(): never {
  throw new Error(CORRUPT);
}

let schemaVersion: number | undefined;
function currentSchemaVersion(): number {
  if (schemaVersion === undefined) {
    const reference = openDatabase(":memory:");
    try {
      schemaVersion = Number(
        reference.pragma("user_version", { simple: true }),
      );
    } finally {
      reference.close();
    }
  }
  return schemaVersion;
}

/** SQLite's own verdict that the file's bytes are not a sound database, as opposed to a failure of the machine. */
function isDamage(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" &&
    (code === "SQLITE_NOTADB" || code.startsWith("SQLITE_CORRUPT"))
  );
}

/**
 * Whether `file` is a sound Pyxis database. False means the file is proven unfit: not a database, damaged, a schema
 * version Pyxis does not know, or missing the tables it needs. Anything about the machine instead (the file cannot be
 * opened or read, the vector extension does not load) is thrown, since it says nothing about the file.
 */
function checkPyxisBackup(file: string): boolean {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const version = Number(db.pragma("user_version", { simple: true }));
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version > currentSchemaVersion()
    )
      return false;
    db.loadExtension(
      getLoadablePath().replaceAll("app.asar", "app.asar.unpacked"),
    );
    const integrity = db.pragma("integrity_check") as Array<{
      integrity_check: string;
    }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
      return false;
    if ((db.pragma("foreign_key_check") as unknown[]).length !== 0)
      return false;
    const names = new Set(
      (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
          .all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    return (
      names.has("plans") && names.has("profile") && names.has("path_nodes")
    );
  } catch (error) {
    if (isDamage(error)) return false;
    throw error;
  } finally {
    db.close();
  }
}

/** A restore treats any failure to vouch for the staged database as an unusable backup. */
function isPyxisBackup(file: string): boolean {
  try {
    return checkPyxisBackup(file);
  } catch {
    return false;
  }
}

function validateMeta(data: Uint8Array): void {
  if (data.byteLength > MAX_META) corrupt();
  try {
    const meta = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(data),
    ) as { mime?: unknown; ext?: unknown };
    if (
      !meta ||
      Array.isArray(meta) ||
      typeof meta.mime !== "string" ||
      !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(meta.mime) ||
      meta.mime.length > 200 ||
      typeof meta.ext !== "string" ||
      !/^[a-zA-Z0-9.]{0,32}$/.test(meta.ext) ||
      Object.keys(meta).some((key) => !["mime", "ext"].includes(key))
    )
      corrupt();
  } catch {
    corrupt();
  }
}

type EntryKind = "db" | "dir" | "blob" | "meta";

/** The canonical whitelist of archive paths. Anything else is corrupt. */
function classify(name: string): EntryKind {
  if (name === "pyxis.db") return "db";
  if (name === "blobs/" || /^blobs\/[a-f0-9]{2}\/$/.test(name)) return "dir";
  const match = /^blobs\/([a-f0-9]{2})\/([a-f0-9]{64})(\.json)?$/.exec(name);
  if (!match || match[1] !== match[2]!.slice(0, 2)) corrupt();
  return match[3] ? "meta" : "blob";
}

function writeAll(fd: number, data: Uint8Array): void {
  let done = 0;
  while (done < data.length)
    done += writeSync(fd, data, done, data.length - done);
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buffer, done, length - done, position + done);
    if (n === 0) corrupt();
    done += n;
  }
  return buffer;
}

type ArchiveEntry = {
  name: string;
  kind: EntryKind;
  method: 0 | 8;
  crc: number;
  packed: number;
  size: number;
  dataStart: number;
};

/**
 * Reads the central directory only, with every declared value checked before any
 * extraction: names, duplicates, limits, local-header agreement and non-overlap.
 * ponytail: ZIP64 and encryption are rejected; backups are capped at 2 GiB.
 */
function readArchiveIndex(fd: number, size: number): ArchiveEntry[] {
  if (size < 22) corrupt();
  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = readAt(fd, size - tailLength, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (
      tail.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + tail.readUInt16LE(i + 20) === tail.length
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) corrupt();
  const count = tail.readUInt16LE(eocd + 10);
  const directorySize = tail.readUInt32LE(eocd + 12);
  const directoryOffset = tail.readUInt32LE(eocd + 16);
  if (
    tail.readUInt16LE(eocd + 4) !== 0 ||
    tail.readUInt16LE(eocd + 6) !== 0 ||
    tail.readUInt16LE(eocd + 8) !== count ||
    count === 0 ||
    count > MAX_ENTRIES ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    directorySize > MAX_DIRECTORY ||
    directoryOffset + directorySize > size - tailLength + eocd
  )
    corrupt();
  const directory = readAt(fd, directoryOffset, directorySize);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ArchiveEntry[] = [];
  const names = new Set<string>();
  const offsets = new Map<string, number>();
  let position = 0;
  let declared = 0;
  for (let i = 0; i < count; i++) {
    if (
      position + 46 > directory.length ||
      directory.readUInt32LE(position) !== 0x02014b50
    )
      corrupt();
    const flag = directory.readUInt16LE(position + 8);
    const method = directory.readUInt16LE(position + 10);
    const crc = directory.readUInt32LE(position + 16);
    const packed = directory.readUInt32LE(position + 20);
    const original = directory.readUInt32LE(position + 24);
    const nameLength = directory.readUInt16LE(position + 28);
    const rest =
      directory.readUInt16LE(position + 30) +
      directory.readUInt16LE(position + 32);
    const offset = directory.readUInt32LE(position + 42);
    if (
      (flag & (0x1 | 0x40 | 0x2000)) !== 0 ||
      (method !== 0 && method !== 8) ||
      directory.readUInt16LE(position + 34) !== 0 ||
      packed === 0xffffffff ||
      original === 0xffffffff ||
      offset === 0xffffffff ||
      (method === 0 && packed !== original) ||
      position + 46 + nameLength + rest > directory.length
    )
      corrupt();
    const rawName = directory.subarray(
      position + 46,
      position + 46 + nameLength,
    );
    position += 46 + nameLength + rest;
    let name: string;
    try {
      name = decoder.decode(rawName);
    } catch {
      corrupt();
    }
    if (names.has(name)) corrupt();
    names.add(name);
    const kind = classify(name);
    declared += original;
    if (
      declared > MAX_EXPANDED ||
      (kind === "dir" && original !== 0) ||
      (kind === "meta" && original > MAX_META)
    )
      corrupt();
    let dataStart = 0;
    if (kind !== "dir") {
      if (offset + 30 > directoryOffset) corrupt();
      const local = readAt(fd, offset, 30 + nameLength);
      if (
        local.readUInt32LE(0) !== 0x04034b50 ||
        local.readUInt16LE(8) !== method ||
        local.readUInt16LE(26) !== nameLength ||
        !local.subarray(30).equals(rawName)
      )
        corrupt();
      dataStart = offset + 30 + nameLength + local.readUInt16LE(28);
      if (dataStart + packed > directoryOffset) corrupt();
      offsets.set(name, offset);
    }
    entries.push({
      name,
      kind,
      method,
      crc,
      packed,
      size: original,
      dataStart,
    });
  }
  if (position !== directory.length) corrupt();
  const stored = entries
    .filter((entry) => entry.kind !== "dir")
    .map((entry) => ({
      start: offsets.get(entry.name)!,
      end: entry.dataStart + entry.packed,
    }))
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < stored.length; i++)
    if (stored[i]!.start < stored[i - 1]!.end) corrupt();
  if (!names.has("pyxis.db")) corrupt();
  for (const name of names) {
    const kind = classify(name);
    if (kind === "blob" && !names.has(`${name}.json`)) corrupt();
    if (kind === "meta" && !names.has(name.slice(0, -5))) corrupt();
  }
  return entries;
}

/** Streams one entry to staging, enforcing sizes, CRC and blob SHA on emitted bytes. */
function extractEntry(
  fd: number,
  entry: ArchiveEntry,
  staging: string,
  budget: { total: number },
): void {
  const dest = join(staging, ...entry.name.split("/"));
  mkdirSync(dirname(dest), { recursive: true });
  const out = openSync(dest, "wx", 0o600);
  try {
    let emitted = 0;
    let crc = 0;
    const hash = entry.kind === "blob" ? createHash("sha256") : undefined;
    const sink = (chunk: Uint8Array) => {
      emitted += chunk.length;
      budget.total += chunk.length;
      if (emitted > entry.size || budget.total > MAX_EXPANDED) corrupt();
      crc = crc32(chunk, crc);
      hash?.update(chunk);
      writeAll(out, chunk);
    };
    let produced: Uint8Array[] = [];
    const inflate =
      entry.method === 8
        ? new Inflate((chunk) => {
            produced.push(chunk);
          })
        : undefined;
    if (inflate && entry.packed === 0) corrupt();
    let position = entry.dataStart;
    const end = entry.dataStart + entry.packed;
    while (position < end) {
      const length = Math.min(
        end - position,
        inflate ? INFLATE_CHUNK : IO_CHUNK,
      );
      const chunk = readAt(fd, position, length);
      position += length;
      if (!inflate) {
        sink(chunk);
        continue;
      }
      try {
        inflate.push(chunk, position === end);
      } catch {
        corrupt();
      }
      const batch = produced;
      produced = [];
      for (const piece of batch) sink(piece);
    }
    if (emitted !== entry.size || crc !== entry.crc) corrupt();
    if (hash && hash.digest("hex") !== entry.name.slice(-64)) corrupt();
    fsyncSync(out);
  } finally {
    closeSync(out);
  }
}

function preserveCaches(workspace: string, staging: string): void {
  for (const name of ["models", "runtimes"]) {
    const source = join(workspace, name);
    if (!existsSync(source)) continue;
    identity(source);
    cpSync(source, join(staging, name), {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter(path) {
        const info = lstatSync(path);
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
          throw new Error("backup-unsafe-file");
        return true;
      },
    });
  }
}

function vacuumInto(db: Database.Database, dest: string): void {
  try {
    db.prepare("VACUUM INTO ?").run(dest);
  } catch {
    const quoted = `'${dest.replace(/'/g, "''")}'`;
    db.exec(`VACUUM INTO ${quoted}`);
  }
}

type BlobFile = { name: string; path: string; size: number };

/**
 * Whether a file failed because it is gone: deleted (ENOENT), or on Windows pending deletion, where opening or
 * stat-ing it fails with a permission error while it is no longer reachable by its name.
 */
function isGone(error: unknown, path: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT" || !existsSync(path);
}

/** The hash in a blob or metadata archive name. */
function shaOf(name: string): string {
  return name.endsWith(".json") ? name.slice(-69, -5) : name.slice(-64);
}

/** What a live copy knows about blob use, to tell a blob core deleted after the snapshot from one it never had. */
type LiveBlobs = {
  /** Hashes the snapshot uses. */
  referenced: ReadonlySet<string>;
  /** Whether the live database still uses a hash. */
  stillUsed: (sha: string) => boolean;
};

/**
 * Lists blob files (names only) after validating names, pairing and metadata. In a live copy core keeps writing and
 * deleting while this walks: a file that disappears, or a blob without its metadata, is left out when the snapshot does
 * not use it (core is still writing it, or deleted it). When the snapshot uses it but the live database no longer does,
 * core deleted it after the snapshot and the copy stops with `backup-changed`. Otherwise it is damage, refused as in a
 * manual backup.
 */
function collectBlobFiles(workspace: string, live?: LiveBlobs): BlobFile[] {
  const blobsRoot = join(workspace, "blobs");
  let out: BlobFile[] = [];
  if (!existsSync(blobsRoot)) return out;
  identity(blobsRoot);
  const vanished = (error: unknown, path: string): void => {
    if (!live || !isGone(error, path)) throw error;
  };
  const drop = new Set<string>();
  const missing = (sha: string, error?: unknown): void => {
    if (!live) {
      if (error) throw error;
      corrupt();
    }
    if (!live.referenced.has(sha)) drop.add(sha);
    else if (!live.stillUsed(sha)) throw new Error("backup-changed");
    else if (error) throw error;
    else corrupt();
  };

  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      vanished(error, dir);
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let info: ReturnType<typeof lstatSync>;
      try {
        info = lstatSync(full);
      } catch (error) {
        vanished(error, full);
        continue;
      }
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
        throw new Error("backup-unsafe-file");
      // A crash before atomic blob rename can leave an unpublished temporary file.
      // Only a regular file may be skipped; a same-named directory is still validated.
      if (
        info.isFile() &&
        /^\.[a-f0-9]{64}(?:\.json)?\.[a-f0-9-]{36}\.tmp$/.test(name)
      )
        continue;
      // Finder bookkeeping is skipped, never deleted.
      if (info.isFile() && (name === ".DS_Store" || name.startsWith("._")))
        continue;
      if (info.isDirectory()) walk(full);
      else
        out.push({
          name: relative(workspace, full).split(sep).join("/"),
          path: full,
          size: info.size,
        });
    }
  };
  walk(blobsRoot);
  if (out.length + 1 > MAX_ENTRIES) throw new Error("backup-too-many-files");
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  const names = new Set(out.map((file) => file.name));
  for (const file of out) {
    const kind = classify(file.name);
    if (kind !== "blob" && kind !== "meta") corrupt();
    // A crash between the two atomic publications can leave an unpaired blob.
    // Refuse the backup rather than omit recoverable bytes or invent their MIME metadata.
    if (kind === "blob" && !names.has(`${file.name}.json`))
      missing(shaOf(file.name));
    if (kind === "meta") {
      if (!names.has(file.name.slice(0, -5))) {
        missing(shaOf(file.name));
        continue;
      }
      let size: number;
      let bytes: Buffer;
      try {
        size = lstatSync(file.path).size;
        bytes = size > MAX_META ? Buffer.alloc(0) : readFileSync(file.path);
      } catch (error) {
        vanished(error, file.path);
        missing(shaOf(file.name), error);
        continue;
      }
      if (size > MAX_META) corrupt();
      validateMeta(bytes);
    }
  }
  if (drop.size) out = out.filter((file) => !drop.has(shaOf(file.name)));
  return out;
}

function openArchiveFile(path: string): number {
  const fd = openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!fstatSync(fd).isFile()) throw new Error("backup-unsafe-file");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Streams a file into the archive; blob bytes must hash to their file name. */
function addFile(
  zip: Zip,
  name: string,
  path: string,
  budget: { total: number },
  stopped?: () => boolean,
): void {
  const fd = openArchiveFile(path);
  try {
    addOpenFile(zip, name, fd, budget, stopped);
  } finally {
    closeSync(fd);
  }
}

function addOpenFile(
  zip: Zip,
  name: string,
  fd: number,
  budget: { total: number },
  stopped?: () => boolean,
): void {
  const entry = new ZipDeflate(name);
  zip.add(entry);
  const kind = classify(name);
  const hash = kind === "blob" ? createHash("sha256") : undefined;
  const metadata: Uint8Array[] = [];
  let metadataSize = 0;
  const buffer = Buffer.allocUnsafe(IO_CHUNK);
  for (;;) {
    if (stopped?.()) throw new Error("backup-cancelled");
    const n = readSync(fd, buffer, 0, buffer.length, null);
    if (n === 0) break;
    budget.total += n;
    if (budget.total > MAX_EXPANDED)
      throw new Error(`backup-too-large:${budget.total}`);
    const chunk = new Uint8Array(buffer.subarray(0, n));
    hash?.update(chunk);
    if (kind === "meta") {
      metadataSize += n;
      if (metadataSize > MAX_META) corrupt();
      metadata.push(chunk);
    }
    entry.push(chunk, false);
  }
  if (kind === "meta") validateMeta(Buffer.concat(metadata));
  entry.push(new Uint8Array(0), true);
  if (hash && hash.digest("hex") !== name.slice(-64)) corrupt();
}

/**
 * Adds a blob and its metadata together. In a live copy core may delete a blob after the listing (a deleted chat's
 * attachment). That is harmless when the snapshot does not use it; when it does, the copy would miss bytes it needs, so
 * the backup stops with `backup-changed` and is tried again later.
 */
function addBlobPair(
  zip: Zip,
  blob: BlobFile,
  meta: BlobFile,
  budget: { total: number },
  referenced: ReadonlySet<string> | undefined,
  stopped?: () => boolean,
): void {
  const open: number[] = [];
  try {
    for (const file of [blob, meta]) {
      try {
        open.push(openArchiveFile(file.path));
      } catch (error) {
        if (!referenced || !isGone(error, file.path)) throw error;
        if (referenced.has(shaOf(blob.name)))
          throw new Error("backup-changed");
        return;
      }
    }
    addOpenFile(zip, blob.name, open[0]!, budget, stopped);
    addOpenFile(zip, meta.name, open[1]!, budget, stopped);
  } finally {
    for (const fd of open) closeSync(fd);
  }
}

/** A read-only connection to a database another process (core) keeps writing. It never migrates or writes. */
function openLiveDatabase(file: string): Database.Database {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    db.loadExtension(
      getLoadablePath().replaceAll("app.asar", "app.asar.unpacked"),
    );
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Whether the workspace holds anything the student made or imported: a source, a plan, a chat or a whiteboard. An
 * empty workspace is not backed up automatically. On a new computer set up to restore, that copy would be the newest
 * file in a synced folder and look like the one to pick.
 */
export function hasStudyData(workspace: string): boolean {
  const db = openLiveDatabase(join(workspace, "pyxis.db"));
  try {
    return (
      db
        .prepare(
          `SELECT 1 FROM sources UNION ALL SELECT 1 FROM plans UNION ALL SELECT 1 FROM chats
           UNION ALL SELECT 1 FROM whiteboards LIMIT 1`,
        )
        .get() !== undefined
    );
  } finally {
    db.close();
  }
}

/** Whether a job is queued or running. An automatic backup waits for them so it does not compete for the disk. */
export function hasActiveJobs(workspace: string): boolean {
  const db = openLiveDatabase(join(workspace, "pyxis.db"));
  try {
    return (
      db
        .prepare(
          `SELECT 1 FROM jobs WHERE state IN ('queued', 'running') LIMIT 1`,
        )
        .get() !== undefined
    );
  } finally {
    db.close();
  }
}

export type BackupOptions = {
  /**
   * Copy a workspace whose core keeps running. The database is read through its own read-only connection, so VACUUM
   * INTO copies one committed state while core goes on writing. Blobs are immutable once published and only deleted
   * when no row uses them, so the copy checks that every blob the snapshot uses made it into the archive.
   */
  live?: boolean;
  /** Checked between chunks. When it returns true the backup stops with `backup-cancelled`. */
  stopped?: () => boolean;
  /** Receives the temporary folder before anything is written in it, so a caller that kills the worker can remove it. */
  onTemporary?: (path: string) => void;
};

function removeTree(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

export function backupWorkspace(
  workspace: string,
  destZip: string,
  options: BackupOptions = {},
): void {
  const dbPath = join(workspace, "pyxis.db");
  const temporary = mkdtempSync(join(dirname(destZip), ".pyxis-backup-"));
  options.onTemporary?.(temporary);
  const tempDb = join(temporary, "pyxis.db");
  let db: Database.Database | undefined;
  try {
    db = options.live ? openLiveDatabase(dbPath) : openDatabase(dbPath);
    vacuumInto(db, tempDb);
    if (options.stopped?.()) throw new Error("backup-cancelled");
    let live: LiveBlobs | undefined;
    if (options.live) {
      const snapshot = new Database(tempDb, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const source = db;
        live = {
          referenced: namedBlobs(snapshot),
          stillUsed: (sha) => blobNamed(source, sha),
        };
      } finally {
        snapshot.close();
      }
    }
    const blobs = collectBlobFiles(workspace, live);
    if (live) {
      const listed = new Set(
        blobs
          .filter((blob) => classify(blob.name) === "blob")
          .map((blob) => shaOf(blob.name)),
      );
      // A used blob that is not on disk: if the live database still uses it, it was already missing and a manual
      // backup would copy the workspace the same way. If not, core deleted it after the snapshot.
      for (const sha of live.referenced)
        if (!listed.has(sha) && !live.stillUsed(sha))
          throw new Error("backup-changed");
    }
    // The message carries the size so the student sees how far over the limit the workspace is. Blob sizes come
    // from the listing: a live copy must not stat a blob again that core may have deleted since.
    const size = blobs.reduce(
      (sum, blob) => sum + blob.size,
      lstatSync(tempDb).size,
    );
    if (size > MAX_EXPANDED) throw new Error(`backup-too-large:${size}`);
    const archive = join(temporary, "backup.zip");
    const fd = openSync(archive, "wx", 0o600);
    try {
      const budget = { total: 0 };
      const zip = new Zip((error, chunk) => {
        if (error) throw error;
        writeAll(fd, chunk);
      });
      addFile(zip, "pyxis.db", tempDb, budget, options.stopped);
      const byName = new Map(blobs.map((blob) => [blob.name, blob]));
      for (const blob of blobs) {
        if (classify(blob.name) !== "blob") continue;
        addBlobPair(
          zip,
          blob,
          byName.get(`${blob.name}.json`)!,
          budget,
          live?.referenced,
          options.stopped,
        );
      }
      zip.end();
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(archive, destZip);
    syncDirectory(dirname(destZip));
  } finally {
    // The live connection is read-only and must leave core's WAL alone.
    if (db && options.live) db.close();
    else if (db) closeDatabase(db);
    removeTree(temporary);
  }
}

type DirectoryIdentity = { dev: string; ino: string };
type RestoreJournal = {
  version: 1;
  phase: "prepared" | "promoted" | "committed";
  staged: DirectoryIdentity;
  original: DirectoryIdentity | null;
};

function identity(path: string): DirectoryIdentity {
  const info = lstatSync(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("backup-restore-unsafe-path");
  return { dev: info.dev.toString(), ino: info.ino.toString() };
}

function matches(path: string, expected: DirectoryIdentity): boolean {
  if (!existsSync(path)) return false;
  const info = identity(path);
  return info.dev === expected.dev && info.ino === expected.ino;
}

function journalPath(workspace: string): string {
  return `${workspace}.restore-journal.json`;
}

function removeFileIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** No record means no restore is in flight, so a regular leftover .tmp is stale. */
function removeOrphanJournalTemp(workspace: string): void {
  const pending = `${journalPath(workspace)}.tmp`;
  let info;
  try {
    info = lstatSync(pending);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isFile()) throw new Error("backup-restore-recovery-required");
  unlinkSync(pending);
  syncDirectory(dirname(workspace));
}

function writeJournal(
  workspace: string,
  value: RestoreJournal,
  initial = false,
): void {
  const path = journalPath(workspace);
  const temporary = `${path}.tmp`;
  if (initial && existsSync(path))
    throw new Error("backup-restore-recovery-required");
  // Publish even the initial record atomically, before any workspace rename.
  if (!initial) removeFileIfPresent(temporary);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (initial && existsSync(path))
    throw new Error("backup-restore-recovery-required");
  renameSync(temporary, path);
  syncDirectory(dirname(workspace));
}

function readJournal(workspace: string): RestoreJournal | null {
  const path = journalPath(workspace);
  if (!existsSync(path)) return null;
  let data: RestoreJournal;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_META)
      throw new Error("invalid-journal");
    const fd = openSync(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    try {
      const size = fstatSync(fd).size;
      if (size > MAX_META) throw new Error("invalid-journal");
      data = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(readAt(fd, 0, size)),
      ) as RestoreJournal;
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("invalid-journal");
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new Error("backup-restore-journal-invalid");
  }
  const normalizeId = (id: unknown): DirectoryIdentity | null | undefined => {
    if (id === null) return null;
    if (!id || typeof id !== "object") return undefined;
    const fields = id as Record<string, unknown>;
    const normalize = (value: unknown) => {
      if (typeof value === "string" && /^(0|[1-9][0-9]{0,39})$/.test(value)) return value;
      // Read journals created by earlier builds when their number was exact.
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
      return undefined;
    };
    const dev = normalize(fields.dev), ino = normalize(fields.ino);
    return dev !== undefined && ino !== undefined ? { dev, ino } : undefined;
  };
  const staged = normalizeId(data.staged), original = normalizeId(data.original);
  if (
    data.version !== 1 ||
    !["prepared", "promoted", "committed"].includes(data.phase) ||
    !staged ||
    original === undefined
  )
    throw new Error("backup-restore-journal-invalid");
  return { ...data, staged, original };
}

function clearJournal(workspace: string): void {
  unlinkSync(journalPath(workspace));
  const pending = `${journalPath(workspace)}.tmp`;
  if (existsSync(pending)) unlinkSync(pending);
  syncDirectory(dirname(workspace));
}

/** What recovery left live: no restore was in flight, the restored copy (its commit was recorded), or the original. */
export type RestoreOutcome = "none" | "kept" | "rolled-back";

/** Call while core is stopped, before creating a missing workspace directory. */
export function recoverInterruptedRestore(workspace: string): RestoreOutcome {
  const record = readJournal(workspace);
  if (!record) {
    removeOrphanJournalTemp(workspace);
    return "none";
  }
  const staging = `${workspace}.restore`;
  const old = `${workspace}.old`;
  if (record.phase === "committed") {
    if (
      !matches(workspace, record.staged) ||
      !isPyxisBackup(join(workspace, "pyxis.db"))
    )
      throw new Error("backup-restore-recovery-required");
    // Cleanup may have partly deleted old. A committed restore always keeps the new copy.
    if (existsSync(old)) {
      if (!record.original || !matches(old, record.original))
        throw new Error("backup-restore-recovery-required");
      removeTree(old);
    }
    clearJournal(workspace);
    return "kept";
  }
  const liveIsStaged = matches(workspace, record.staged);
  const stageExists = existsSync(staging);
  if (stageExists && !matches(staging, record.staged))
    throw new Error("backup-restore-recovery-required");
  if (liveIsStaged && stageExists)
    throw new Error("backup-restore-recovery-required");
  if (record.original) {
    const oldExists = existsSync(old);
    if (oldExists && !matches(old, record.original))
      throw new Error("backup-restore-recovery-required");
    if (oldExists) {
      if (existsSync(workspace) && !liveIsStaged)
        throw new Error("backup-restore-recovery-required");
      if (liveIsStaged) renameSync(workspace, staging);
      renameSync(old, workspace);
      syncDirectory(dirname(workspace));
    } else if (!matches(workspace, record.original)) {
      throw new Error("backup-restore-recovery-required");
    }
  } else {
    if (existsSync(old) || (existsSync(workspace) && !liveIsStaged))
      throw new Error("backup-restore-recovery-required");
    if (liveIsStaged) renameSync(workspace, staging);
  }
  if (existsSync(staging)) removeTree(staging);
  clearJournal(workspace);
  return "rolled-back";
}

/** Call after new core readiness. False means cleanup is pending, never rollback. */
export function commitWorkspaceRestore(workspace: string): boolean {
  const record = readJournal(workspace);
  if (!record) return true;
  if (
    record.phase === "prepared" ||
    !matches(workspace, record.staged) ||
    !isPyxisBackup(join(workspace, "pyxis.db"))
  ) {
    throw new Error("backup-restore-recovery-required");
  }
  // Persist commitment before any old data is deleted. Cleanup failure keeps this marker.
  if (record.phase !== "committed")
    writeJournal(workspace, { ...record, phase: "committed" });
  try {
    recoverInterruptedRestore(workspace);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the archive can be restored as far as its database goes: the zip index is well formed, `pyxis.db` inflates
 * with a matching CRC, and the database passes the checks a restore runs on its staging copy (`integrity_check`, foreign
 * keys, schema version, the tables Pyxis needs). Blobs are not unpacked, so a damaged blob is only found by a restore.
 * Needs room for the database in the temporary folder.
 *
 * False means the archive is proven unusable. A failure of the machine, such as a full or unusable temporary folder,
 * a read error or a file that cannot be reached, proves nothing about the archive and is thrown instead, so a caller
 * never takes it for a broken file.
 */
export function verifyBackupArchive(zipPath: string): boolean {
  // A path that is not there throws too: a drive that is unplugged may come back with the same file on it.
  const fd = openSync(zipPath, "r");
  let staging: string | undefined;
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return false;
    const entry = readArchiveIndex(fd, info.size).find(
      (item) => item.name === "pyxis.db",
    );
    if (!entry) return false;
    staging = mkdtempSync(join(tmpdir(), "pyxis-verify-"));
    extractEntry(fd, entry, staging, { total: 0 });
    return checkPyxisBackup(join(staging, "pyxis.db"));
  } catch (error) {
    if (error instanceof Error && error.message === CORRUPT) return false;
    throw error;
  } finally {
    closeSync(fd);
    if (staging) removeTree(staging);
  }
}

/**
 * The check after a live backup. An archive proven unusable is deleted and the backup fails as `backup-unverified`.
 * If the check cannot run (see `verifyBackupArchive`), the error is thrown and the file stays: it may well be good.
 */
export function verifyOrDiscardBackup(zipPath: string): void {
  try {
    if (verifyBackupArchive(zipPath)) return;
  } catch (error) {
    // A file that is already gone leaves nothing to keep. Any other error says nothing about the file.
    if (existsSync(zipPath)) throw error;
  }
  rmSync(zipPath, { force: true });
  throw new Error("backup-unverified");
}

export function restoreWorkspace(
  zipPath: string,
  workspace: string,
  options: { deferCommit?: boolean } = {},
): void {
  recoverInterruptedRestore(workspace);
  let zipFd: number;
  try {
    zipFd = openSync(zipPath, "r");
  } catch {
    corrupt();
  }
  try {
    restoreFromArchive(zipFd, workspace, options);
  } finally {
    closeSync(zipFd);
  }
}

function restoreFromArchive(
  zipFd: number,
  workspace: string,
  options: { deferCommit?: boolean },
): void {
  let index: ArchiveEntry[];
  try {
    const info = fstatSync(zipFd);
    if (!info.isFile()) corrupt();
    index = readArchiveIndex(zipFd, info.size);
  } catch {
    corrupt();
  }
  const staging = `${workspace}.restore`;
  const old = `${workspace}.old`;
  // Unjournalled copies may belong to a failed older build. Never erase them implicitly.
  if (
    existsSync(staging) ||
    existsSync(old) ||
    existsSync(`${journalPath(workspace)}.tmp`)
  )
    throw new Error("backup-restore-recovery-required");
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  let journalled = false;
  try {
    const budget = { total: 0 };
    for (const entry of index) {
      if (entry.kind === "dir") {
        mkdirSync(join(staging, ...entry.name.split("/")), { recursive: true });
        continue;
      }
      extractEntry(zipFd, entry, staging, budget);
    }
    for (const entry of index)
      if (entry.kind === "meta")
        validateMeta(readFileSync(join(staging, ...entry.name.split("/"))));
    const stagedDb = join(staging, "pyxis.db");
    if (!isPyxisBackup(stagedDb)) corrupt();
    try {
      closeDatabase(openDatabase(stagedDb));
    } catch {
      corrupt();
    }
    if (!isPyxisBackup(stagedDb)) corrupt();
    preserveCaches(workspace, staging);
    syncDirectory(staging);
    const record: RestoreJournal = {
      version: 1,
      phase: "prepared",
      staged: identity(staging),
      original: existsSync(workspace) ? identity(workspace) : null,
    };
    writeJournal(workspace, record, true);
    journalled = true;
    if (record.original) renameSync(workspace, old);
    syncDirectory(dirname(workspace));
    renameSync(staging, workspace);
    syncDirectory(dirname(workspace));
    writeJournal(workspace, { ...record, phase: "promoted" });
    if (!options.deferCommit) commitWorkspaceRestore(workspace);
  } catch (error) {
    if (journalled || existsSync(journalPath(workspace)))
      recoverInterruptedRestore(workspace);
    else removeTree(staging);
    throw error;
  }
}
