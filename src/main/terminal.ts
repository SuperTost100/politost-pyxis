import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { installDirs } from "../core/engine/install";

/** Programs setup may start in a terminal. Only Antigravity has no sign-in Pyxis can run itself. */
export type TerminalProgram = "antigravity";

/** Finds `agy` where CLI Funnel and the vendor installer put it. */
export function findAntigravity(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string | null {
  const override = env.CLI_FUNNEL_AGY_BIN;
  const dirs = [
    ...(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean),
    join(home, ".local", "bin"),
    ...installDirs(platform, env, home),
  ];
  const exts = platform === "win32" ? [".exe", ".cmd", ""] : [""];
  const candidates = [
    ...(override ? [override] : []),
    ...dirs.flatMap((dir) => exts.map((ext) => join(dir, `agy${ext}`))),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this folder; try the next one.
    }
  }
  return null;
}

function launch(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore" });
    child.once("error", () => reject(new Error("terminal-unavailable")));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Opens the system terminal, empty or running `program`. The program path comes from this process, never from the
 * renderer.
 */
export async function openTerminal(
  program: TerminalProgram | undefined,
  openApp: (path: string) => Promise<string>,
): Promise<void> {
  const path = program === "antigravity" ? findAntigravity() : null;
  if (program && !path) throw new Error("program-missing");
  if (process.platform === "darwin") {
    if (path) return launch("open", ["-a", "Terminal", path]);
    const error = await openApp("/System/Applications/Utilities/Terminal.app");
    if (error) throw new Error("terminal-unavailable");
    return;
  }
  if (process.platform === "win32")
    return launch("cmd.exe", ["/c", "start", "", path ?? "cmd.exe"]);
  return launch("x-terminal-emulator", path ? ["-e", path] : []);
}
