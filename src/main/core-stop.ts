/** How long core gets to checkpoint, close the database and exit on its own before it is killed. */
export const CORE_STOP_GRACE_MS = 3_000;
/** How long after the request a stop may take in all, the kill included, before it fails with `core-busy`. */
export const CORE_STOP_LIMIT_MS = 15_000;

/** The part of Electron's UtilityProcess the stop uses. */
type CoreProcess = {
  kill(): boolean;
  postMessage(message: unknown): void;
  once(event: "exit", listener: () => void): unknown;
  off(event: "exit", listener: () => void): unknown;
};

const exited = new WeakSet<CoreProcess>();
const stopping = new WeakMap<CoreProcess, Promise<void>>();

/**
 * Marks the core as gone when its process exits. Electron emits `exit` once the process has ended, so this is the only
 * place a core counts as exited: one that was told to stop or killed can still hold pyxis.db open until then.
 */
export function watchCoreExit(child: CoreProcess): void {
  child.once("exit", () => exited.add(child));
}

export function coreExited(child: CoreProcess): boolean {
  return exited.has(child);
}

/**
 * Asks core to shut down and resolves once its process has exited. Core checkpoints and closes the database before it
 * exits, so the files copied next are complete. One still running after `graceMs` is killed, and the stop then waits for
 * that exit too: on a slow Windows computer a killed process can take seconds to go. Rejects with `core-busy` only when
 * the process is still there `limitMs` after the request. A stop already under way, such as the kill of a core whose
 * start failed, is shared rather than started again, so whatever follows waits for the same exit.
 */
export function stopCoreProcess(
  child: CoreProcess,
  graceMs = CORE_STOP_GRACE_MS,
  limitMs = CORE_STOP_LIMIT_MS,
): Promise<void> {
  if (exited.has(child)) return Promise.resolve();
  const running = stopping.get(child);
  if (running) return running;
  const stop = new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(kill);
      clearTimeout(limit);
      stopping.delete(child);
      exited.add(child);
      resolve();
    };
    const kill = setTimeout(() => child.kill(), graceMs);
    const limit = setTimeout(() => {
      clearTimeout(kill);
      child.off("exit", done);
      stopping.delete(child);
      reject(new Error("core-busy"));
    }, limitMs);
    child.once("exit", done);
    child.postMessage({ type: "shutdown" });
  });
  stopping.set(child, stop);
  return stop;
}
