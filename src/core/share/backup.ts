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
import { dirname, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { getLoadablePath } from "sqlite-vec";
import { Inflate, Zip, ZipDeflate } from "fflate";
import { openDatabase } from "../db/connection";

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

function isPyxisBackup(file: string): boolean {
  let db: Database.Database;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return false;
  }
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
  } catch {
    return false;
  } finally {
    db.close();
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

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(previous: number, data: Uint8Array): number {
  let c = ~previous;
  for (let i = 0; i < data.length; i++)
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
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
      crc = crc32(crc, chunk);
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

type BlobFile = { name: string; path: string };

/** Lists blob files (names only) after validating names, pairing and metadata. */
function collectBlobFiles(workspace: string): BlobFile[] {
  const blobsRoot = join(workspace, "blobs");
  const out: BlobFile[] = [];
  if (!existsSync(blobsRoot)) return out;
  identity(blobsRoot);

  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const info = lstatSync(full);
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
        });
    }
  };
  walk(blobsRoot);
  if (out.length + 1 > MAX_ENTRIES) throw new Error("backup-too-large");
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  const names = new Set(out.map((file) => file.name));
  for (const file of out) {
    const kind = classify(file.name);
    if (kind !== "blob" && kind !== "meta") corrupt();
    // A crash between the two atomic publications can leave an unpaired blob.
    // Refuse the backup rather than omit recoverable bytes or invent their MIME metadata.
    if (kind === "blob" && !names.has(`${file.name}.json`)) corrupt();
    if (kind === "meta") {
      if (!names.has(file.name.slice(0, -5))) corrupt();
      if (lstatSync(file.path).size > MAX_META) corrupt();
      validateMeta(readFileSync(file.path));
    }
  }
  return out;
}

/** Streams a file into the archive; blob bytes must hash to their file name. */
function addFile(
  zip: Zip,
  name: string,
  path: string,
  budget: { total: number },
): void {
  const fd = openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!fstatSync(fd).isFile()) throw new Error("backup-unsafe-file");
    const entry = new ZipDeflate(name);
    zip.add(entry);
    const kind = classify(name);
    const hash = kind === "blob" ? createHash("sha256") : undefined;
    const metadata: Uint8Array[] = [];
    let metadataSize = 0;
    const buffer = Buffer.allocUnsafe(IO_CHUNK);
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      budget.total += n;
      if (budget.total > MAX_EXPANDED) throw new Error("backup-too-large");
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
  } finally {
    closeSync(fd);
  }
}

function removeTree(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

export function backupWorkspace(workspace: string, destZip: string): void {
  const dbPath = join(workspace, "pyxis.db");
  const temporary = mkdtempSync(join(dirname(destZip), ".pyxis-backup-"));
  const tempDb = join(temporary, "pyxis.db");
  let db: Database.Database | undefined;
  try {
    db = openDatabase(dbPath);
    vacuumInto(db, tempDb);
    const blobs = collectBlobFiles(workspace);
    const archive = join(temporary, "backup.zip");
    const fd = openSync(archive, "wx", 0o600);
    try {
      const budget = { total: 0 };
      const zip = new Zip((error, chunk) => {
        if (error) throw error;
        writeAll(fd, chunk);
      });
      addFile(zip, "pyxis.db", tempDb, budget);
      for (const blob of blobs) addFile(zip, blob.name, blob.path, budget);
      zip.end();
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(archive, destZip);
    syncDirectory(dirname(destZip));
  } finally {
    db?.close();
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

function syncDirectory(path: string): void {
  // Windows does not support opening a directory for fsync. Journal files still sync.
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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

/** Call while core is stopped, before creating a missing workspace directory. */
export function recoverInterruptedRestore(workspace: string): void {
  const record = readJournal(workspace);
  if (!record) {
    removeOrphanJournalTemp(workspace);
    return;
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
    return;
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
      const db = openDatabase(stagedDb);
      db.close();
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
