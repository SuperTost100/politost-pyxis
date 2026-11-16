import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";
import drawing from "../../resources/drawing-manifest.json";
import pyodide from "../../resources/pyodide-manifest.json";
import { readCapped } from "../core/sources/capped-body";
import { sha256 } from "../core/sources/quality";
import { runtimePackIds, type PackId } from "../shared/figure-kinds";

type PackFile = { name: string; size: number; sha256: string; url: string };
type Pack = {
  version: string;
  files: PackFile[];
  totalBytes: number;
  /** Whether the folders of earlier versions are deleted once this version is verified. */
  replacesOlder: boolean;
  /**
   * Whether a file is hashed every time it is read, not only when its size, modification time or inode has changed. A
   * file rewritten in place with its modification time put back would pass the stamp. The drawing pack is small, so it is
   * hashed on every read; Python's is 31 MB and keeps the stamp.
   */
  hashEveryRead: boolean;
};
function pack(version: string, files: PackFile[], replacesOlder: boolean, hashEveryRead = false): Pack {
  return {
    version,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    replacesOlder,
    hashEveryRead,
  };
}
/**
 * The downloaded packs, each pinned by version, size and SHA-256 in its manifest and kept in
 * `workspace/runtimes/<pack>/<version>/`. Python's files all come from one folder of its CDN. The drawing pack's
 * files come from where each renderer is published, so every file names its own URL. Python runs need only `pyodide`;
 * `figure-kinds.ts` says which packs each kind of figure needs.
 */
export const runtimePacks: Record<PackId, Pack> = {
  pyodide: pack(
    pyodide.version,
    pyodide.files.map((file) => ({ ...file, url: pyodide.baseURL + file.name })),
    false,
  ),
  drawing: pack(drawing.version, drawing.files, true, true),
};
export type PackPhase = "idle" | "downloading" | "ready" | "failed";
/**
 * `packs` is each pack on its own. The rest describes the download as the Python page shows it: `ready` when every
 * pack is there, and otherwise the bytes of the packs still missing, which is what Download fetches.
 */
export type RuntimeStatus = {
  phase: PackPhase;
  bytes: number;
  totalBytes: number;
  error?: string;
  packs: Record<PackId, PackPhase>;
};
/** `bytes` and `totalBytes` count the download that is running, over every pack it fetches. */
type State = {
  packs: Record<PackId, PackPhase>;
  bytes: number;
  totalBytes: number;
  error?: string;
};
const states = new Map<string, State>();
const installs = new Map<string, Promise<void>>();
const controllers = new Map<string, AbortController>();
const everyByte = runtimePackIds.reduce(
  (sum, id) => sum + runtimePacks[id].totalBytes,
  0,
);
function stateOf(workspace: string): State {
  let state = states.get(workspace);
  if (!state) {
    state = { packs: { pyodide: "idle", drawing: "idle" }, bytes: 0, totalBytes: 0 };
    states.set(workspace, state);
  }
  return state;
}
function summary(state: State): RuntimeStatus {
  const packs = { ...state.packs };
  const missing = runtimePackIds.filter((id) => packs[id] !== "ready");
  const totalBytes = missing.reduce(
    (sum, id) => sum + runtimePacks[id].totalBytes,
    0,
  );
  if (missing.some((id) => packs[id] === "downloading"))
    return {
      phase: "downloading",
      bytes: state.bytes,
      totalBytes: state.totalBytes,
      packs,
    };
  if (!missing.length)
    return { phase: "ready", bytes: everyByte, totalBytes: everyByte, packs };
  if (missing.some((id) => packs[id] === "failed"))
    return { phase: "failed", bytes: 0, totalBytes, error: state.error, packs };
  return { phase: "idle", bytes: 0, totalBytes, packs };
}
/**
 * Runtime files whose hash matched, by path, with the size, modification time and inode they had then. Every Python run
 * loads the whole runtime again (about 31 MB), so a file is hashed again only when one of those changes: a rewrite in
 * place moves the modification time, and a replacement brings a new inode.
 */
const verified = new Map<string, string>();
function stamp(stats: BigIntStats): string {
  return `${stats.size}:${stats.mtimeNs}:${stats.ino}`;
}
function packRoot(workspace: string, id: PackId): string {
  return join(workspace, "runtimes", id, runtimePacks[id].version);
}
export async function verifiedRuntimeFile(
  workspace: string,
  id: PackId,
  name: string,
): Promise<Uint8Array | undefined> {
  const file = runtimePacks[id].files.find((file) => file.name === name);
  if (!file) return undefined;
  const path = join(packRoot(workspace, id), name);
  try {
    const handle = await open(path, "r");
    try {
      // Read before the bytes, so a write during the read leaves a stamp that no longer matches and the next load hashes.
      const before = stamp(await handle.stat({ bigint: true }));
      const bytes = await handle.readFile();
      if (
        bytes.length === file.size &&
        ((!runtimePacks[id].hashEveryRead && verified.get(path) === before) ||
          sha256(bytes) === file.sha256)
      ) {
        verified.set(path, before);
        return new Uint8Array(bytes);
      }
      verified.delete(path);
      return undefined;
    } finally {
      await handle.close();
    }
  } catch {
    verified.delete(path);
    return undefined;
  }
}
/** Whether a runtime file is in place and verified, without reading it again when it is unchanged since its last check. */
async function runtimeFileReady(
  workspace: string,
  id: PackId,
  name: string,
): Promise<boolean> {
  const path = join(packRoot(workspace, id), name);
  const known = runtimePacks[id].hashEveryRead ? undefined : verified.get(path);
  if (known) {
    try {
      if (stamp(await stat(path, { bigint: true })) === known) return true;
    } catch {
      verified.delete(path);
      return false;
    }
  }
  return Boolean(await verifiedRuntimeFile(workspace, id, name));
}
/** Disk truth for one pack: every file of its manifest present and hash-verified. */
async function packOnDisk(workspace: string, id: PackId): Promise<boolean> {
  const files = await Promise.all(
    runtimePacks[id].files.map((file) =>
      runtimeFileReady(workspace, id, file.name),
    ),
  );
  return files.every(Boolean);
}
/**
 * Disk truth for every pack that is not being downloaded. Never downloads. A pack whose download failed stays failed
 * until its files are there.
 */
export async function currentRuntimeStatus(
  workspace: string,
): Promise<RuntimeStatus> {
  const state = stateOf(workspace);
  const idle = runtimePackIds.filter((id) => state.packs[id] !== "downloading");
  const onDisk = await Promise.all(idle.map((id) => packOnDisk(workspace, id)));
  idle.forEach((id, index) => {
    // A download that started during the look owns the pack's phase.
    if (state.packs[id] === "downloading") return;
    state.packs[id] = onDisk[index]
      ? "ready"
      : state.packs[id] === "failed"
        ? "failed"
        : "idle";
  });
  return summary(state);
}
/** Execution entry: the pack must already be installed by explicit consent. */
export async function requireRuntime(
  workspace: string,
  id: PackId = "pyodide",
): Promise<void> {
  if (stateOf(workspace).packs[id] === "ready") return;
  if ((await currentRuntimeStatus(workspace)).packs[id] !== "ready")
    throw new Error("runtime-missing");
}
/**
 * Forgets that a pack was verified: its next use looks at the disk again, and a file that fails its hash makes the pack
 * not ready, so nothing opens a window for it until the student downloads it again. Called when a window could not load
 * a file of the pack.
 */
export function invalidatePack(workspace: string, id: PackId): void {
  const state = states.get(workspace);
  if (state && state.packs[id] === "ready") state.packs[id] = "idle";
  for (const file of runtimePacks[id].files) verified.delete(join(packRoot(workspace, id), file.name));
}
export function cancelRuntimeDownload(workspace: string): void {
  controllers.get(workspace)?.abort();
}
/**
 * Fetches every pack that is not on disk. Only the explicit local-runtime-download job calls this, so a workspace that
 * has Python but lacks a newer pack gets that pack when the student presses Download on the Python page, never on its
 * own.
 */
export function downloadRuntime(workspace: string): Promise<void> {
  const existing = installs.get(workspace);
  if (existing) return existing;
  const controller = new AbortController();
  controllers.set(workspace, controller);
  const promise = install(workspace, controller.signal).catch(
    (error: unknown) => {
      installs.delete(workspace);
      const state = stateOf(workspace);
      const cancelled = controller.signal.aborted;
      for (const id of runtimePackIds)
        if (state.packs[id] === "downloading")
          state.packs[id] = cancelled ? "idle" : "failed";
      state.error = cancelled
        ? undefined
        : error instanceof Error
          ? error.message
          : "runtime-download-failed";
      throw error;
    },
  );
  void promise.then(
    () => {
      controllers.delete(workspace);
      installs.delete(workspace);
    },
    () => controllers.delete(workspace),
  );
  installs.set(workspace, promise);
  return promise;
}
/** Stop writes before a restore or wipe replaces this workspace. */
export async function invalidateRuntime(workspace: string): Promise<void> {
  controllers.get(workspace)?.abort();
  await installs.get(workspace)?.catch(() => undefined);
  installs.delete(workspace);
  controllers.delete(workspace);
  states.delete(workspace);
  const root = join(workspace, "runtimes") + sep;
  for (const path of [...verified.keys()])
    if (path.startsWith(root)) verified.delete(path);
}
async function install(workspace: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const state = stateOf(workspace);
  // A pack that is already there is left alone, so Python keeps running while another pack downloads.
  const missing: PackId[] = [];
  for (const id of runtimePackIds) {
    if (await packOnDisk(workspace, id)) state.packs[id] = "ready";
    else missing.push(id);
  }
  signal.throwIfAborted();
  state.bytes = 0;
  state.totalBytes = missing.reduce(
    (sum, id) => sum + runtimePacks[id].totalBytes,
    0,
  );
  state.error = undefined;
  for (const id of missing) state.packs[id] = "downloading";
  for (const id of missing) {
    await installPack(workspace, id, signal, state);
    state.packs[id] = "ready";
    if (runtimePacks[id].replacesOlder) await removeOlderVersions(workspace, id);
  }
}
/** Deletes the folders of a pack's earlier versions, which nothing reads once this version is verified. */
async function removeOlderVersions(workspace: string, id: PackId): Promise<void> {
  const root = join(workspace, "runtimes", id);
  // Best effort: a folder that cannot be listed or deleted only keeps its space.
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter(
        (entry) => entry.isDirectory() && entry.name !== runtimePacks[id].version,
      )
      .map((entry) =>
        rm(join(root, entry.name), { recursive: true, force: true }).catch(
          () => undefined,
        ),
      ),
  );
}
async function installPack(
  workspace: string,
  id: PackId,
  signal: AbortSignal,
  state: State,
): Promise<void> {
  const root = packRoot(workspace, id);
  const { files } = runtimePacks[id];
  signal.throwIfAborted();
  await mkdir(root, { recursive: true });
  signal.throwIfAborted();
  for (let offset = 0; offset < files.length; offset += 4) {
    const batch = await Promise.allSettled(
      files.slice(offset, offset + 4).map(async (file) => {
        signal.throwIfAborted();
        if (!(await runtimeFileReady(workspace, id, file.name))) {
          const response = await fetch(file.url, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
          });
          if (!response.ok || !response.body)
            throw new Error(`runtime-download-${response.status}`);
          const bytes = await readCapped(response.body, file.size, () => new Error("runtime-file-too-large"), {
            signal,
          });
          if (
            bytes.byteLength !== file.size ||
            sha256(bytes) !== file.sha256
          )
            throw new Error("runtime-integrity-failed");
          const staging = join(root, `${file.name}.${randomUUID()}.tmp`);
          try {
            signal.throwIfAborted();
            await writeFile(staging, bytes, { flag: "wx" });
            signal.throwIfAborted();
            await rename(staging, join(root, file.name));
          } finally {
            await rm(staging, { force: true });
          }
        }
        signal.throwIfAborted();
        state.bytes += file.size;
      }),
    );
    const failed = batch.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  signal.throwIfAborted();
}
