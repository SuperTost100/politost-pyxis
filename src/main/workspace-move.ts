import { constants, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import Database from "better-sqlite3";

export type WorkspaceMove = {
  path: string;
  /** Call only after configuration is saved and core starts successfully. */
  commit(): Promise<boolean>;
  /** Stop the new core before rollback. The original workspace stays intact. */
  rollback(): Promise<void>;
  /** Choose a verified copy without deleting either folder. Stop both cores first. */
  recoveryPath(): Promise<string>;
};

function inside(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return (
    part === "" ||
    (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part))
  );
}

function sameFile(
  a: { dev: number; ino: number },
  b: { dev: number; ino: number },
): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function hashFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile())
      throw new Error("workspace-move-special-file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(buffer);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

async function copyTree(source: string, destination: string): Promise<void> {
  const names = (await readdir(source)).sort();
  for (const name of names) {
    const from = join(source, name);
    const to = join(destination, name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error("workspace-move-symlink");
    if (info.isDirectory()) {
      await mkdir(to, { mode: 0o700 });
      await copyTree(from, to);
      continue;
    }
    if (!info.isFile()) throw new Error("workspace-move-special-file");
    const input = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
    let output: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const initial = await input.stat();
      if (!initial.isFile() || !sameFile(initial, info))
        throw new Error("workspace-move-source-changed");
      output = await open(to, "wx", info.mode & 0o777);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let copied = 0;
      for (;;) {
        const { bytesRead } = await input.read(buffer);
        if (bytesRead === 0) break;
        await output.writeFile(buffer.subarray(0, bytesRead));
        copied += bytesRead;
      }
      await output.sync();
      const final = await input.stat();
      if (
        copied !== initial.size ||
        final.size !== initial.size ||
        final.mtimeMs !== initial.mtimeMs
      )
        throw new Error("workspace-move-source-changed");
    } finally {
      await input.close();
      await output?.close();
    }
    if ((await hashFile(from)) !== (await hashFile(to)))
      throw new Error("workspace-move-copy-mismatch");
  }
  if (JSON.stringify(names) !== JSON.stringify((await readdir(source)).sort()))
    throw new Error("workspace-move-source-changed");
}

function verifyDatabase(path: string): void {
  const db = new Database(join(path, "pyxis.db"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    if (db.pragma("integrity_check", { simple: true }) !== "ok")
      throw new Error("workspace-move-database-corrupt");
    if (Number(db.pragma("user_version", { simple: true })) < 1)
      throw new Error("workspace-move-database-invalid");
    db.prepare("SELECT id FROM plans LIMIT 1").get();
    db.prepare("SELECT id FROM profile LIMIT 1").get();
  } finally {
    db.close();
  }
}

/** Core must be stopped and the workspace write lock held throughout this operation. */
export async function stageWorkspaceMove(
  oldPath: string,
  targetPath: string,
): Promise<WorkspaceMove> {
  if (!isAbsolute(oldPath) || !isAbsolute(targetPath))
    throw new Error("workspace-move-path-invalid");
  const original = await lstat(oldPath);
  if (!original.isDirectory() || original.isSymbolicLink())
    throw new Error("workspace-move-source-invalid");
  const source = await realpath(oldPath);
  const parent = await realpath(dirname(targetPath));
  const target = join(parent, basename(targetPath));
  if (inside(source, target) || inside(target, source))
    throw new Error("workspace-move-path-overlap");
  const exists = await lstat(target).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (exists) throw new Error("workspace-move-destination-exists");
  // mkdir below reserves the destination without ever replacing an existing folder.
  const staging = await mkdtemp(join(parent, ".pyxis-move-"));
  let reservation: Stats | undefined;
  try {
    await copyTree(source, staging);
    verifyDatabase(staging);
    if (!sameFile(original, await lstat(source)))
      throw new Error("workspace-move-source-changed");
    await mkdir(target, { mode: 0o700 });
    reservation = await lstat(target);
    if (process.platform === "win32") {
      // Windows rename refuses any existing destination directory, including
      // our empty reservation. A competing directory still makes rename fail.
      await rmdir(target);
      reservation = undefined;
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (reservation) {
      // A competing writer may have populated our reservation. Remove it only
      // when it remains the same empty directory; never delete their files.
      try {
        if (sameFile(reservation, await lstat(target))) await rmdir(target);
      } catch {
        /* Preserve a populated or replaced reservation. */
      }
    }
    throw error;
  }
  const copied = await lstat(target);
  let state: "staged" | "committed" | "rolled-back" = "staged";
  let oldRemoved = false;
  async function healthy(path: string, expected: Stats): Promise<boolean> {
    try {
      const folder = await lstat(path);
      if (!folder.isDirectory() || !sameFile(expected, folder)) return false;
      const database = await lstat(join(path, "pyxis.db"));
      if (!database.isFile()) return false;
      verifyDatabase(path);
      return sameFile(expected, await lstat(path));
    } catch {
      return false;
    }
  }
  return {
    path: target,
    async recoveryPath() {
      // A committed move may have partially removed the old tree during cleanup.
      if (state !== "committed" && (await healthy(source, original)))
        return source;
      if (await healthy(target, copied)) return target;
      throw new Error("workspace-move-recovery-unavailable");
    },
    async commit() {
      if (state === "committed") return oldRemoved;
      if (state !== "staged")
        throw new Error("workspace-move-already-rolled-back");
      if (
        !sameFile(copied, await lstat(target)) ||
        !sameFile(original, await lstat(source))
      )
        throw new Error("workspace-move-path-changed");
      // Once cleanup begins, rollback must never delete the only complete copy.
      state = "committed";
      try {
        await rm(source, { recursive: true });
        oldRemoved = true;
        return true;
      } catch {
        return false;
      } // New workspace remains active; old files can be removed later.
    },
    async rollback() {
      if (state === "rolled-back") return;
      if (state !== "staged")
        throw new Error("workspace-move-already-committed");
      if (
        !sameFile(copied, await lstat(target)) ||
        !sameFile(original, await lstat(source))
      )
        throw new Error("workspace-move-path-changed");
      verifyDatabase(source);
      await rm(target, { recursive: true });
      state = "rolled-back";
    },
  };
}
