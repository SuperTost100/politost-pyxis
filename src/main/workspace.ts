import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { app } from "electron";

type ConfigFile = { workspacePath?: string };

function userFile(name: string): string {
  return join(app.getPath("userData"), name);
}

export function ensureWorkspaceDirs(workspace: string): void {
  for (const dir of ["blobs", "runtimes", "models", "scratch", "exports"]) {
    mkdirSync(join(workspace, dir), { recursive: true });
  }
}

export function ensureWorkspace(): string {
  const cfgPath = userFile("config.json");
  let saved: ConfigFile | null = null;
  try {
    saved = JSON.parse(readFileSync(cfgPath, "utf8")) as ConfigFile;
  } catch {
    saved = null;
  }
  const workspace =
    saved?.workspacePath && isAbsolute(saved.workspacePath)
      ? saved.workspacePath
      : join(app.getPath("userData"), "workspace");
  ensureWorkspaceDirs(workspace);
  if (saved?.workspacePath !== workspace) {
    writeFileSync(
      cfgPath,
      JSON.stringify({ workspacePath: workspace }, null, 2),
    );
  }
  return workspace;
}
