import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const names = ["pyxis.db", "pyxis.db-wal", "pyxis.db-shm", "blobs", "runtimes", "models", "scratch", "exports"];
const dirs = ["blobs", "runtimes", "models", "scratch", "exports"];

function holdingDir(workspace: string): string {
  return join(workspace, ".wipe");
}

/** Puts an unfinished wipe back. A finished wipe only drops the extra copy. */
export function recoverInterruptedWipe(workspace: string): void {
  const holding = holdingDir(workspace);
  if (!existsSync(holding)) return;
  const unfinished = existsSync(join(holding, "INCOMPLETE"));
  if (unfinished) {
    for (const name of names) {
      const from = join(holding, name);
      const to = join(workspace, name);
      if (!existsSync(from) || existsSync(to)) continue;
      cpSync(from, to, { recursive: true });
    }
  }
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
  for (const name of names) {
    const from = join(workspace, name);
    if (!existsSync(from)) continue;
    cpSync(from, join(holding, name), { recursive: true });
  }
  try {
    for (const name of names) rmSync(join(workspace, name), { recursive: true, force: true });
  } catch (err) {
    recoverInterruptedWipe(workspace);
    throw err instanceof Error ? err : new Error("wipe-failed");
  }
  rmSync(join(holding, "INCOMPLETE"), { force: true });
  rmSync(holding, { recursive: true, force: true });
  for (const dir of dirs) mkdirSync(join(workspace, dir), { recursive: true });
}
