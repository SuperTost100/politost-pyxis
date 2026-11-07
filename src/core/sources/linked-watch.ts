import { watch as fsWatch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { inside } from "../path-inside";

/** Quiet time after the last change before the folder is read again: a copy of many files is read once, at the end. */
export const WATCH_QUIET_MS = 2_000;
/** A folder that keeps changing (a long sync) is still read at least this often. */
export const WATCH_MAX_WAIT_MS = 20_000;

type Watch = (
  path: string,
  options: { recursive: boolean; persistent: boolean },
  listener: (event: string, name: string | Buffer | null) => void,
) => Pick<FSWatcher, "close" | "on">;

/**
 * Calls `onChange` once a burst of changes in a folder is over: `quietMs` after the last event, or `maxWaitMs` after
 * the first one when events never stop. A change under a hidden name (`.DS_Store`, an editor's lock file, a `.git`
 * folder) is ignored, as the folder listing ignores it, and so is one inside `exclude`: a linked folder can hold Pyxis's
 * own workspace, whose writes after each look would otherwise start the next one. A change the system reports without
 * a name still counts. Only watches: it never opens, creates or touches anything in the folder. A watch that fails
 * (the folder was removed, the system ran out of watches) closes and calls `onError`, and the next start tries again.
 */
export function watchFolder(
  path: string,
  onChange: () => void,
  options: {
    quietMs?: number;
    maxWaitMs?: number;
    onError?: (err: unknown) => void;
    /** Folders inside `path` whose changes never count, such as the workspace. */
    exclude?: readonly string[];
    watch?: Watch;
  } = {},
): { close(): void } {
  const quietMs = options.quietMs ?? WATCH_QUIET_MS;
  const maxWaitMs = options.maxWaitMs ?? WATCH_MAX_WAIT_MS;
  const watch = options.watch ?? (fsWatch as unknown as Watch);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstAt: number | null = null;
  let closed = false;
  const fire = () => {
    timer = undefined;
    firstAt = null;
    if (!closed) onChange();
  };
  const listener = (_event: string, name: string | Buffer | null) => {
    if (closed) return;
    if (name) {
      const rel = name.toString();
      if (rel.split(/[\\/]/).some((part) => part.startsWith("."))) return;
      const full = resolve(path, rel);
      if (options.exclude?.some((place) => inside(place, full))) return;
    }
    const now = Date.now();
    firstAt ??= now;
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, Math.max(0, Math.min(quietMs, firstAt + maxWaitMs - now)));
  };
  let watcher: Pick<FSWatcher, "close" | "on">;
  try {
    try {
      watcher = watch(path, { recursive: true, persistent: false }, listener);
    } catch (err) {
      // A platform without recursive watching still sees what happens at the top of the folder.
      if ((err as NodeJS.ErrnoException).code !== "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") throw err;
      watcher = watch(path, { recursive: false, persistent: false }, listener);
    }
  } catch (err) {
    options.onError?.(err);
    return { close() {} };
  }
  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    watcher.close();
  };
  watcher.on("error", (err) => {
    close();
    options.onError?.(err);
  });
  return { close };
}
