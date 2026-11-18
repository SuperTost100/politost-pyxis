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
/** One pack as the Settings rows show it. */
export type PackInfo = {
  phase: PackPhase;
  /** The bytes of the download that is running or stopped, or the whole pack when it is ready. */
  bytes: number;
  /** The bytes this pack's download fetches: the pack's size. */
  totalBytes: number;
  /** The pack's size on disk once downloaded (the sum of its files, as its manifest pins them). */
  size: number;
  /** The version this app's manifest pins. */
  version: string;
  /**
   * The workspace holds an older version of this pack and not this one. Files of an older version cannot be checked
   * against this app's manifest, so they are never run: the pack is not ready until it is downloaded again.
   */
  outdated: boolean;
  error?: string;
};
/**
 * `packs` and `info` describe each pack on its own. The rest describes the downloads as the Python page shows them:
 * `ready` when every pack is there, and otherwise the bytes of the packs still missing, which is what Download fetches.
 */
export type RuntimeStatus = {
  phase: PackPhase;
  bytes: number;
  totalBytes: number;
  error?: string;
  packs: Record<PackId, PackPhase>;
  info: Record<PackId, PackInfo>;
};
type PackState = { phase: PackPhase; bytes: number; totalBytes: number; error?: string };
/**
 * Each pack's own state, so one pack's download, failure or removal never touches the other's. `changes` counts the
 * times a pack's state was written, so a look at the disk can tell that its result is older than what happened since.
 */
type State = {
  packs: Record<PackId, PackState>;
  outdated: Record<PackId, boolean>;
  changes: Record<PackId, number>;
  chain: Set<PackId>;
};
const states = new Map<string, State>();
/** The download of one pack in one workspace, and the way to stop it. Keyed by `key`. */
const installs = new Map<string, Promise<void>>();
const controllers = new Map<string, AbortController>();
const key = (workspace: string, id: PackId) => `${workspace}\0${id}`;
const everyByte = runtimePackIds.reduce(
  (sum, id) => sum + runtimePacks[id].totalBytes,
  0,
);
const fresh = (id: PackId): PackState => ({ phase: "idle", bytes: 0, totalBytes: runtimePacks[id].totalBytes });
function stateOf(workspace: string): State {
  let state = states.get(workspace);
  if (!state) {
    state = {
      packs: Object.fromEntries(runtimePackIds.map((id) => [id, fresh(id)])) as Record<PackId, PackState>,
      outdated: Object.fromEntries(runtimePackIds.map((id) => [id, false])) as Record<PackId, boolean>,
      changes: Object.fromEntries(runtimePackIds.map((id) => [id, 0])) as Record<PackId, number>,
      chain: new Set(),
    };
    states.set(workspace, state);
  }
  return state;
}
/** Writes a pack's state, and counts it. */
function setPack(state: State, id: PackId, next: PackState): void {
  state.packs[id] = next;
  state.changes[id] += 1;
}
function summary(state: State): RuntimeStatus {
  const phases = Object.fromEntries(runtimePackIds.map((id) => [id, state.packs[id].phase])) as Record<PackId, PackPhase>;
  const info = Object.fromEntries(
    runtimePackIds.map((id) => {
      const own = state.packs[id];
      return [
        id,
        {
          phase: own.phase,
          bytes: own.phase === "ready" ? runtimePacks[id].totalBytes : own.bytes,
          totalBytes: runtimePacks[id].totalBytes,
          size: runtimePacks[id].totalBytes,
          version: runtimePacks[id].version,
          outdated: state.outdated[id],
          ...(own.error ? { error: own.error } : {}),
        } satisfies PackInfo,
      ];
    }),
  ) as Record<PackId, PackInfo>;
  const missing = runtimePackIds.filter((id) => phases[id] !== "ready");
  const totalBytes = missing.reduce(
    (sum, id) => sum + runtimePacks[id].totalBytes,
    0,
  );
  if (missing.some((id) => phases[id] === "downloading")) {
    // One download over every pack that started together, so the progress does not run backwards as one finishes.
    const together = runtimePackIds.filter((id) => phases[id] === "downloading" || state.chain.has(id));
    return {
      phase: "downloading",
      bytes: together.reduce((sum, id) => sum + (phases[id] === "ready" ? runtimePacks[id].totalBytes : state.packs[id].bytes), 0),
      totalBytes: together.reduce((sum, id) => sum + runtimePacks[id].totalBytes, 0),
      packs: phases,
      info,
    };
  }
  if (!missing.length)
    return { phase: "ready", bytes: everyByte, totalBytes: everyByte, packs: phases, info };
  const failed = missing.find((id) => phases[id] === "failed");
  if (failed)
    return { phase: "failed", bytes: 0, totalBytes, error: state.packs[failed].error, packs: phases, info };
  return { phase: "idle", bytes: 0, totalBytes, packs: phases, info };
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
/** Whether the workspace holds a folder of another version of the pack, which this app's manifest cannot vouch for. */
async function hasOtherVersion(workspace: string, id: PackId): Promise<boolean> {
  const entries = await readdir(join(workspace, "runtimes", id), { withFileTypes: true }).catch(() => []);
  return entries.some((entry) => entry.isDirectory() && entry.name !== runtimePacks[id].version);
}
/**
 * Disk truth for every pack that is not being downloaded. Never downloads. A pack whose download failed stays failed
 * until its files are there. A pack whose files are not there but whose folder of an older version is, is `outdated`: it
 * is offered as an update, and nothing is fetched or run until the student asks.
 */
export async function currentRuntimeStatus(
  workspace: string,
): Promise<RuntimeStatus> {
  const state = stateOf(workspace);
  const idle = runtimePackIds.filter((id) => state.packs[id].phase !== "downloading");
  const seen = idle.map((id) => state.changes[id]);
  const onDisk = await Promise.all(idle.map((id) => packOnDisk(workspace, id)));
  const older = await Promise.all(idle.map((id, index) => (onDisk[index] ? false : hasOtherVersion(workspace, id))));
  idle.forEach((id, index) => {
    const own = state.packs[id];
    // What happened to the pack during the look (a download that started, or started and ended, a removal) is newer
    // than what the look saw, and owns the pack's phase.
    if (own.phase === "downloading" || state.changes[id] !== seen[index]) return;
    state.outdated[id] = older[index]!;
    if (onDisk[index]) setPack(state, id, { ...fresh(id), phase: "ready", bytes: runtimePacks[id].totalBytes });
    else if (own.phase === "ready") setPack(state, id, fresh(id));
  });
  if (!runtimePackIds.some((id) => state.packs[id].phase === "downloading")) state.chain.clear();
  return summary(state);
}
/** Execution entry: the pack must already be installed by explicit consent. */
export async function requireRuntime(
  workspace: string,
  id: PackId = "pyodide",
): Promise<void> {
  if (stateOf(workspace).packs[id].phase === "ready") return;
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
  if (state && state.packs[id].phase === "ready") setPack(state, id, fresh(id));
  for (const file of runtimePacks[id].files) verified.delete(join(packRoot(workspace, id), file.name));
}
/** Stops the downloads of these packs (every pack when none is named). */
export function cancelRuntimeDownload(workspace: string, only: readonly PackId[] = runtimePackIds): void {
  for (const id of only) controllers.get(key(workspace, id))?.abort();
}
/**
 * Where a file comes from: the URL its manifest names. An end-to-end run (PYXIS_E2E=1 with PYXIS_E2E_PACK_BASE) gets
 * it from a local server that stands in for the CDN, as `<base>/<pack>/<file>`. Unset outside those runs.
 */
function fileUrl(id: PackId, file: PackFile): string {
  const base = process.env["PYXIS_E2E"] === "1" ? process.env["PYXIS_E2E_PACK_BASE"] : undefined;
  return base ? `${base.replace(/\/$/, "")}/${id}/${file.name}` : file.url;
}
/**
 * Fetches the packs named (every pack when none is), each on its own, so one that fails or is cancelled leaves the others
 * as they were. Only the explicit runtime download jobs call this, so a workspace that has Python but lacks a newer pack
 * gets that pack when the student asks for it, never on its own. A pack that is already on its way is joined, not
 * started again. Rejects with the first failure after every pack has settled.
 */
export async function downloadRuntime(
  workspace: string,
  only: readonly PackId[] = runtimePackIds,
): Promise<void> {
  const results = await Promise.allSettled(only.map((id) => downloadPack(workspace, id)));
  const rejected = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
  // A pack that failed is the failure to report; one that was only stopped is reported when nothing else went wrong.
  const failure = rejected.find((reason) => !isAbortReason(reason)) ?? rejected[0];
  if (rejected.length) throw failure;
}
function isAbortReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "AbortError";
}
function downloadPack(workspace: string, id: PackId): Promise<void> {
  const k = key(workspace, id);
  const existing = installs.get(k);
  if (existing) return existing;
  const controller = new AbortController();
  controllers.set(k, controller);
  const state = stateOf(workspace);
  let own: PackState = fresh(id);
  const promise = (async () => {
    controller.signal.throwIfAborted();
    if (await packOnDisk(workspace, id)) {
      setPack(state, id, { ...fresh(id), phase: "ready", bytes: runtimePacks[id].totalBytes });
      return;
    }
    // Only now is it a download: a pack that was already there is no part of the transfer's total or its progress.
    own = { phase: "downloading", bytes: 0, totalBytes: runtimePacks[id].totalBytes };
    setPack(state, id, own);
    state.chain.add(id);
    await installPack(workspace, id, controller.signal, own);
    setPack(state, id, { ...fresh(id), phase: "ready", bytes: runtimePacks[id].totalBytes });
    state.outdated[id] = false;
    if (runtimePacks[id].replacesOlder) await removeOlderVersions(workspace, id);
  })()
    .catch((error: unknown) => {
      const cancelled = controller.signal.aborted;
      // A stopped download keeps how far it got, so the row can say where it stopped; a cancelled one starts over.
      setPack(
        state,
        id,
        cancelled
          ? fresh(id)
          : {
              phase: "failed",
              bytes: own.bytes,
              totalBytes: runtimePacks[id].totalBytes,
              error: error instanceof Error ? error.message : "runtime-download-failed",
            },
      );
      throw error;
    })
    .finally(() => {
      installs.delete(k);
      controllers.delete(k);
    });
  installs.set(k, promise);
  return promise;
}
/**
 * Removes a pack: stops its download, forgets its files at once, so nothing is served or run from them from here on, and
 * deletes the folders of every version of it. The other pack is left alone.
 */
export async function removeRuntimePack(workspace: string, id: PackId): Promise<void> {
  const k = key(workspace, id);
  controllers.get(k)?.abort();
  await installs.get(k)?.catch(() => undefined);
  const state = stateOf(workspace);
  setPack(state, id, fresh(id));
  state.outdated[id] = false;
  const root = join(workspace, "runtimes", id);
  for (const path of [...verified.keys()]) if (path.startsWith(root + sep)) verified.delete(path);
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  // A look at the disk that began while the folders were being deleted may have read files that were still there: counted
  // again now that they are gone, so that look, which saw the count before this, is dropped as the one before the deletion was.
  // A look in the meantime may also have found an older folder that is gone now, and said the pack is outdated.
  setPack(state, id, fresh(id));
  state.outdated[id] = false;
}
/** Stop writes before a restore or wipe replaces this workspace. */
export async function invalidateRuntime(workspace: string): Promise<void> {
  const mine = runtimePackIds.map((id) => key(workspace, id));
  for (const k of mine) controllers.get(k)?.abort();
  await Promise.all(mine.map((k) => installs.get(k)?.catch(() => undefined)));
  for (const k of mine) {
    installs.delete(k);
    controllers.delete(k);
  }
  states.delete(workspace);
  const root = join(workspace, "runtimes") + sep;
  for (const path of [...verified.keys()])
    if (path.startsWith(root)) verified.delete(path);
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
  state: PackState,
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
          const response = await fetch(fileUrl(id, file), {
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
