import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { app } from "electron";
import { recoverInterruptedRestore, syncDirectory } from "../core/share/backup";

type ConfigFile = { workspacePath?: unknown };

function userFile(name: string): string {
  return join(app.getPath("userData"), name);
}

export function ensureWorkspaceDirs(workspace: string): void {
  for (const dir of ["blobs", "runtimes", "models", "scratch", "exports"]) {
    mkdirSync(join(workspace, dir), { recursive: true });
  }
}

/**
 * The workspace path in config.json, or null when there is no config.json yet (a first launch). A file that can't be
 * read or doesn't hold an absolute path throws workspace-missing: it may have pointed at a moved workspace, and opening
 * the default one instead would show setup as if the student's data were gone.
 */
function savedWorkspacePath(cfgPath: string): string | null {
  let saved: ConfigFile | null;
  try {
    saved = JSON.parse(readFileSync(cfgPath, "utf8")) as ConfigFile | null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.error("pyxis: config.json can't be read", (error as Error).message);
    throw new Error("workspace-missing");
  }
  const path = saved?.workspacePath;
  if (typeof path === "string" && isAbsolute(path)) return path;
  console.error("pyxis: config.json has no workspace path");
  throw new Error("workspace-missing");
}

/** Records the workspace path so that a power cut leaves the old config.json or the new one, never an empty file. */
export function saveWorkspacePath(path: string): void {
  const cfgPath = userFile("config.json");
  const temporary = `${cfgPath}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    writeFileSync(fd, JSON.stringify({ workspacePath: path }, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, cfgPath);
  syncDirectory(dirname(cfgPath));
}

export function ensureWorkspace(): string {
  const saved = savedWorkspacePath(userFile("config.json"));
  const workspace = saved ?? join(app.getPath("userData"), "workspace");
  recoverInterruptedRestore(workspace);
  // A folder chosen with Move always holds pyxis.db. Without it the folder is most likely on a drive that isn't
  // connected; creating an empty workspace there would open setup as if the student's data were gone.
  if (
    workspace !== join(app.getPath("userData"), "workspace") &&
    !existsSync(join(workspace, "pyxis.db"))
  )
    throw new Error("workspace-missing");
  ensureWorkspaceDirs(workspace);
  if (saved !== workspace) saveWorkspacePath(workspace);
  return workspace;
}
