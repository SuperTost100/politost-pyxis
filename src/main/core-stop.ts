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

/**
 * Asks core to shut down and resolves once its process has exited. Core checkpoints and closes the database before it
 * exits, so the files copied next are complete. One still running after `graceMs` is killed, and the stop then waits for
 * that exit too: on a slow Windows computer a killed process can take seconds to go. Rejects with `core-busy` only when
 * the process is still there `limitMs` after the request.
 */
export function stopCoreProcess(
  child: CoreProcess,
  graceMs = CORE_STOP_GRACE_MS,
  limitMs = CORE_STOP_LIMIT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const exited = () => {
      clearTimeout(kill);
      clearTimeout(limit);
      resolve();
    };
    const kill = setTimeout(() => child.kill(), graceMs);
    const limit = setTimeout(() => {
      clearTimeout(kill);
      child.off("exit", exited);
      reject(new Error("core-busy"));
    }, limitMs);
    child.once("exit", exited);
    child.postMessage({ type: "shutdown" });
  });
}
