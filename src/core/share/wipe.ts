import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

const names = ["pyxis.db", "pyxis.db-wal", "pyxis.db-shm", "blobs", "runtimes", "models", "scratch", "exports"];
const dirs = ["blobs", "runtimes", "models", "scratch", "exports"];

function holdingDir(workspace: string): string {
  return join(workspace, ".wipe");
}

/** Whether a wipe stopped with data still in `.wipe`. Core must not open the workspace until it is put back. */
export function wipePending(workspace: string): boolean {
  return existsSync(join(holdingDir(workspace), "INCOMPLETE"));
}

/**
 * Ends a wipe or its recovery once nothing in `.wipe` needs to come back. Removing INCOMPLETE is the step that counts;
 * the folder itself can stay when a virus scanner holds a file in it (EBUSY on Windows). It holds nothing to restore, so
 * the next start deletes it. Returns false when the folder stayed.
 */
function discardHolding(holding: string): boolean {
  rmSync(join(holding, "INCOMPLETE"), { force: true });
  try {
    rmSync(holding, { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch {
    return false;
  }
}

function restoreEntry(from: string, to: string): void {
  if (!existsSync(from)) return;
  if (!existsSync(to)) {
    renameSync(from, to);
    return;
  }
  if (statSync(from).isDirectory() && statSync(to).isDirectory()) {
    for (const child of readdirSync(from)) restoreEntry(join(from, child), join(to, child));
  }
}

/**
 * Puts an unfinished wipe back, including files inside a folder startup already recreated. A `.wipe` without INCOMPLETE
 * is what a finished wipe left: it is deleted when it can be and otherwise left for the next start.
 */
export function recoverInterruptedWipe(workspace: string): void {
  const holding = holdingDir(workspace);
  if (!existsSync(holding)) return;
  if (!existsSync(join(holding, "INCOMPLETE"))) {
    discardHolding(holding);
    return;
  }
  const dbNames = ["pyxis.db-wal", "pyxis.db-shm", "pyxis.db"];
  if (!existsSync(join(workspace, "pyxis.db"))) {
    // Sidecars move first. A stop before the database lands still has no live database, so the next launch finishes them.
    for (const name of dbNames) restoreEntry(join(holding, name), join(workspace, name));
  }
  for (const name of names) {
    if (dbNames.includes(name)) continue;
    restoreEntry(join(holding, name), join(workspace, name));
  }
  discardHolding(holding);
}

/**
 * Deletes the study data. The data moves into `.wipe` first, so a stop part-way puts it back on the next start; once it
 * is all there, removing INCOMPLETE makes the wipe final. Returns false when `.wipe` could not be removed afterwards.
 */
export function wipeWorkspace(workspace: string): boolean {
  if (!isAbsolute(workspace) || workspace === "/" || workspace === "") {
    throw new Error("workspace-path");
  }
  recoverInterruptedWipe(workspace);
  const holding = holdingDir(workspace);
  mkdirSync(holding);
  writeFileSync(join(holding, "INCOMPLETE"), "1");
  const moved: string[] = [];
  try {
    for (const name of names) {
      const from = join(workspace, name);
      if (!existsSync(from)) continue;
      renameSync(from, join(holding, name));
      moved.push(name);
    }
  } catch (err) {
    if (existsSync(holding)) {
      writeFileSync(join(holding, "INCOMPLETE"), "1");
      for (const name of [...moved].reverse()) restoreEntry(join(holding, name), join(workspace, name));
      discardHolding(holding);
    }
    throw err instanceof Error ? err : new Error("wipe-failed");
  }
  const removed = discardHolding(holding);
  for (const dir of dirs) mkdirSync(join(workspace, dir), { recursive: true });
  return removed;
}
