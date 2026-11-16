import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Saves a trace so that only a copy cleaned of the launch environment can reach the folder a failed job uploads. The raw
 * zip, which holds every variable of the job's environment, is written to a folder of its own in the run's temporary
 * folder, never under `test-results/`; `attach` receives the cleaned copy, and the folder with the raw zip is removed
 * whatever happened, including when `stop` saves the zip and then rejects (the app exited before Playwright's last
 * request). A raw zip that exists is cleaned and kept even then, since the trace of an app that went away is the one
 * worth reading. Returns whether a trace was attached, and throws what went wrong after the folder is gone.
 */
export async function saveTrace({
  stop,
  attach,
  maxBytes,
  clean: withoutEnvironment,
}: {
  /** Writes the trace's zip to the path it is given, as `tracing.stop({ path })` does. */
  stop: (rawPath: string) => Promise<unknown>;
  /** Takes the cleaned zip; it must copy it, since the folder is removed when this returns. */
  attach: (cleanPath: string) => Promise<void>;
  maxBytes: number;
  /** Returns the zip without the launch environment, or throws (`withoutLaunchEnvironment`). */
  clean: (zip: Uint8Array) => Uint8Array;
}): Promise<boolean> {
  const folder = mkdtempSync(join(tmpdir(), "pyxis-trace-raw-"));
  try {
    const raw = join(folder, "raw.zip");
    const clean = join(folder, "trace.zip");
    let stopped: unknown;
    try {
      await stop(raw);
    } catch (error) {
      stopped = error;
    }
    if (!existsSync(raw)) {
      if (stopped) throw stopped;
      return false;
    }
    writeFileSync(clean, withoutEnvironment(readFileSync(raw)));
    rmSync(raw, { force: true });
    const kept = statSync(clean).size <= maxBytes;
    if (kept) await attach(clean);
    if (stopped) throw stopped;
    return kept;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
