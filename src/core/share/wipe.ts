import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const names = ["pyxis.db", "pyxis.db-wal", "pyxis.db-shm", "blobs", "runtimes", "models", "scratch", "exports"];
const dirs = ["blobs", "runtimes", "models", "scratch", "exports"];

export function wipeWorkspace(workspace: string): void {
  if (!isAbsolute(workspace) || workspace === "/" || workspace === "") {
    throw new Error("workspace-path");
  }
  const holding = join(workspace, ".wipe");
  rmSync(holding, { recursive: true, force: true });
  mkdirSync(holding);
  const moved: string[] = [];
  try {
    for (const name of names) {
      const from = join(workspace, name);
      if (!existsSync(from)) continue;
      renameSync(from, join(holding, name));
      moved.push(name);
    }
    rmSync(holding, { recursive: true, force: true });
  } catch (err) {
    for (const name of moved.reverse()) {
      const from = join(holding, name);
      if (existsSync(from)) renameSync(from, join(workspace, name));
    }
    rmSync(holding, { recursive: true, force: true });
    throw err;
  }
  for (const dir of dirs) mkdirSync(join(workspace, dir), { recursive: true });
}
