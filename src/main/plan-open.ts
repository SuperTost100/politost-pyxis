import { open, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_OPENED_PLAN_BYTES, type OpenedPlan } from "../shared/bridge";

/** The names a plan file has: what Pyxis saves, and what its documentation calls the format. */
const PLAN_SUFFIXES = [".pyxis", ".pyxis.json"];

export function isPlanFileName(path: string): boolean {
  const name = path.toLowerCase();
  return PLAN_SUFFIXES.some((suffix) => name.endsWith(suffix) && name.length > suffix.length);
}

/**
 * The plan file a launch names: Windows and Linux pass the double-clicked file as an argument, first launch or
 * `second-instance`. The first argument that is not a flag and has a plan file name wins. A relative path is read from
 * where the new process started. Nothing is read here.
 */
/**
 * Whether a plan file that arrives with no main window should open one. Not before startup has made its first window:
 * startup may still be waiting on a dialog, and it creates that window itself, after the handlers the window calls on
 * load are registered. The file waits and the window takes it then.
 */
export function needsWindowForPlan(startupDone: boolean, windowCount: number): boolean {
  return startupDone && windowCount === 0;
}

export function planFileFromArgv(argv: readonly string[], workingDirectory = process.cwd()): string | null {
  const name = argv.find((arg) => arg.length > 0 && !arg.startsWith("-") && isPlanFileName(arg));
  return name === undefined ? null : resolve(workingDirectory, name);
}

/**
 * Reads a plan file the system handed to Pyxis. The renderer never names a path: main keeps the one the system gave
 * it, and checks it again here. The file must have a plan file name once symbolic links are followed, be a regular
 * file (not a pipe or device that could block the read) and fit the size cap of a linked plan.
 */
export async function readOpenedPlan(path: string): Promise<OpenedPlan> {
  try {
    const real = await realpath(path);
    if (!isPlanFileName(real)) return { ok: false, reason: "not-a-plan-file" };
    const before = await stat(real);
    if (!before.isFile()) return { ok: false, reason: "not-a-plan-file" };
    if (before.size > MAX_OPENED_PLAN_BYTES) return { ok: false, reason: "too-big" };
    const handle = await open(real, "r");
    try {
      // The file may have changed since the check; the handle's own size is the one that counts.
      const info = await handle.stat();
      if (!info.isFile()) return { ok: false, reason: "not-a-plan-file" };
      if (info.size > MAX_OPENED_PLAN_BYTES) return { ok: false, reason: "too-big" };
      const bytes = await handle.readFile();
      if (bytes.length > MAX_OPENED_PLAN_BYTES) return { ok: false, reason: "too-big" };
      return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } finally {
      await handle.close();
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}
