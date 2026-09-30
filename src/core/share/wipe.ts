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

/** Puts an unfinished wipe back, including files inside a folder startup already recreated. */
export function recoverInterruptedWipe(workspace: string): void {
  const holding = holdingDir(workspace);
  if (!existsSync(holding)) return;
  if (!existsSync(join(holding, "INCOMPLETE"))) {
    rmSync(holding, { recursive: true, force: true });
    return;
  }
  for (const name of names) restoreEntry(join(holding, name), join(workspace, name));
  rmSync(holding, { recursive: true, force: true });
}

export function wipeWorkspace(workspace: string): void {
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
      rmSync(holding, { recursive: true, force: true });
    }
    throw err instanceof Error ? err : new Error("wipe-failed");
  }
  rmSync(join(holding, "INCOMPLETE"), { force: true });
  rmSync(holding, { recursive: true, force: true });
  for (const dir of dirs) mkdirSync(join(workspace, dir), { recursive: true });
}
