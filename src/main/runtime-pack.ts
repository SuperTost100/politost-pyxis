import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import manifest from "../../resources/pyodide-manifest.json";
import { readCapped } from "../core/sources/capped-body";
import { sha256 } from "../core/sources/quality";

export const runtimeManifest = manifest;
export type RuntimeStatus = {
  phase: "idle" | "downloading" | "ready" | "failed";
  bytes: number;
  totalBytes: number;
  error?: string;
};
const states = new Map<string, RuntimeStatus>();
const installs = new Map<string, Promise<string>>();
const controllers = new Map<string, AbortController>();
const totalBytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
function runtimeStatus(workspace: string): RuntimeStatus {
  return states.get(workspace) ?? { phase: "idle", bytes: 0, totalBytes };
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
function runtimePath(workspace: string, name: string): string {
  return join(workspace, "runtimes", "pyodide", manifest.version, name);
}
export async function verifiedRuntimeFile(
  workspace: string,
  name: string,
): Promise<Uint8Array | undefined> {
  const file = manifest.files.find((file) => file.name === name);
  if (!file) return undefined;
  const path = runtimePath(workspace, name);
  try {
    const handle = await open(path, "r");
    try {
      // Read before the bytes, so a write during the read leaves a stamp that no longer matches and the next load hashes.
      const before = stamp(await handle.stat({ bigint: true }));
      const bytes = await handle.readFile();
      if (
        bytes.length === file.size &&
        (verified.get(path) === before ||
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
async function runtimeFileReady(workspace: string, name: string): Promise<boolean> {
  const path = runtimePath(workspace, name);
  const known = verified.get(path);
  if (known) {
    try {
      if (stamp(await stat(path, { bigint: true })) === known) return true;
    } catch {
      verified.delete(path);
      return false;
    }
  }
  return Boolean(await verifiedRuntimeFile(workspace, name));
}
/** Disk truth: every manifest file present and hash-verified. Never downloads. */
export async function currentRuntimeStatus(
  workspace: string,
): Promise<RuntimeStatus> {
  const state = runtimeStatus(workspace);
  if (state.phase === "downloading") return state;
  const files = await Promise.all(
    manifest.files.map((file) => runtimeFileReady(workspace, file.name)),
  );
  if (files.every(Boolean)) {
    const ready: RuntimeStatus = {
      phase: "ready",
      bytes: totalBytes,
      totalBytes,
    };
    states.set(workspace, ready);
    return ready;
  }
  if (state.phase === "failed") return state;
  const idle: RuntimeStatus = { phase: "idle", bytes: 0, totalBytes };
  states.set(workspace, idle);
  return idle;
}
/** Execution entry: the runtime must already be installed by explicit consent. */
export async function requireRuntime(workspace: string): Promise<void> {
  if (runtimeStatus(workspace).phase === "ready") return;
  if ((await currentRuntimeStatus(workspace)).phase !== "ready")
    throw new Error("runtime-missing");
}
export function cancelRuntimeDownload(workspace: string): void {
  controllers.get(workspace)?.abort();
}
/** Only the explicit local-runtime-download job calls this. */
export function downloadRuntime(workspace: string): Promise<string> {
  const existing = installs.get(workspace);
  if (existing) return existing;
  const controller = new AbortController();
  controllers.set(workspace, controller);
  const promise = install(workspace, controller.signal).catch(
    (error: unknown) => {
      installs.delete(workspace);
      states.set(
        workspace,
        controller.signal.aborted
          ? { phase: "idle", bytes: 0, totalBytes }
          : {
              ...runtimeStatus(workspace),
              phase: "failed",
              error:
                error instanceof Error
                  ? error.message
                  : "runtime-download-failed",
            },
      );
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
  for (const name of manifest.files.map((file) => file.name))
    verified.delete(runtimePath(workspace, name));
}
async function install(
  workspace: string,
  signal: AbortSignal,
): Promise<string> {
  const root = join(workspace, "runtimes", "pyodide", manifest.version);
  signal.throwIfAborted();
  await mkdir(root, { recursive: true });
  signal.throwIfAborted();
  states.set(workspace, { phase: "downloading", bytes: 0, totalBytes });
  for (let offset = 0; offset < manifest.files.length; offset += 4) {
    const batch = await Promise.allSettled(
      manifest.files.slice(offset, offset + 4).map(async (file) => {
        signal.throwIfAborted();
        if (!(await runtimeFileReady(workspace, file.name))) {
          const response = await fetch(manifest.baseURL + file.name, {
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
        states.set(workspace, {
          phase: "downloading",
          bytes: runtimeStatus(workspace).bytes + file.size,
          totalBytes,
        });
      }),
    );
    const failed = batch.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  signal.throwIfAborted();
  states.set(workspace, { phase: "ready", bytes: totalBytes, totalBytes });
  return root;
}
