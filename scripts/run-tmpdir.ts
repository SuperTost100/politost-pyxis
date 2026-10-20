import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Removes a folder tree, including read-only folders and files that tests create on purpose. Each entry gets write
 * permission back first, because deleting a name needs write access to the folder that holds it.
 */
export function removeTree(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) removeTree(join(path, name));
    } else if (!stat.isSymbolicLink()) {
      chmodSync(path, 0o600);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    // A path we cannot open still gets the plain removal below, which reports the real error.
  }
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * Points TMPDIR (TMP and TEMP on Windows) at a fresh folder for this run, so folders that a test or an app under test
 * forgets to remove disappear with it. Call it before any worker starts, since workers copy the environment when they
 * spawn. Returns the function that removes the folder.
 */
export function useRunTmpdir(): () => void {
  const run = mkdtempSync(join(tmpdir(), "pyxis-run-"));
  process.env.TMPDIR = run;
  process.env.TMP = run;
  process.env.TEMP = run;
  return () => removeTree(run);
}
