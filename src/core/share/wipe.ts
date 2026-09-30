import { mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const dirs = ["blobs", "runtimes", "models", "scratch", "exports"];

export function wipeWorkspace(workspace: string): void {
  if (!isAbsolute(workspace) || workspace === "/" || workspace === "") {
    throw new Error("workspace-path");
  }
  for (const name of ["pyxis.db", "pyxis.db-wal", "pyxis.db-shm"]) {
    rmSync(join(workspace, name), { force: true });
  }
  for (const dir of dirs) rmSync(join(workspace, dir), { recursive: true, force: true });
  for (const dir of dirs) mkdirSync(join(workspace, dir), { recursive: true });
}
