import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import manifest from "../../resources/pyodide-manifest.json";

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
export function runtimeStatus(workspace: string): RuntimeStatus {
  return states.get(workspace) ?? { phase: "idle", bytes: 0, totalBytes };
}
export async function verifiedRuntimeFile(
  workspace: string,
  name: string,
): Promise<Uint8Array | undefined> {
  const file = manifest.files.find((file) => file.name === name);
  if (!file) return undefined;
  try {
    const bytes = await readFile(
      join(workspace, "runtimes", "pyodide", manifest.version, name),
    );
    return bytes.length === file.size &&
      createHash("sha256").update(bytes).digest("hex") === file.sha256
      ? new Uint8Array(bytes)
      : undefined;
  } catch {
    return undefined;
  }
}
/** Disk truth: every manifest file present and hash-verified. Never downloads. */
export async function currentRuntimeStatus(
  workspace: string,
): Promise<RuntimeStatus> {
  const state = runtimeStatus(workspace);
  if (state.phase === "downloading") return state;
  const files = await Promise.all(
    manifest.files.map((file) => verifiedRuntimeFile(workspace, file.name)),
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
        if (!(await verifiedRuntimeFile(workspace, file.name))) {
          const response = await fetch(manifest.baseURL + file.name, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
          });
          if (!response.ok || !response.body)
            throw new Error(`runtime-download-${response.status}`);
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of response.body) {
            signal.throwIfAborted();
            size += chunk.length;
            if (size > file.size) throw new Error("runtime-file-too-large");
            chunks.push(chunk);
          }
          const bytes = Buffer.concat(chunks);
          if (
            size !== file.size ||
            createHash("sha256").update(bytes).digest("hex") !== file.sha256
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
