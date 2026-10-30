import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Removes a test folder once Pyxis has quit. Retries for about five seconds, since a virus scanner can still have a new
 * file open, then fails naming every file still held.
 */
export function removeTestFolder(root: string) {
  try {
    // Node waits 250 ms longer before each retry, so six retries wait 5.25 s in all, well inside a test's timeout.
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 6,
      retryDelay: 250,
    });
  } catch (error) {
    const held: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else
          try {
            rmSync(path, { force: true });
          } catch {
            held.push(path);
          }
      }
    };
    walk(root);
    throw new Error(
      `${(error as Error).message}; still held: ${held.join(", ") || "only folders"}`,
    );
  }
}
