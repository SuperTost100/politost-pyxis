import { spawn } from "node:child_process";

const MARK = "__PYXIS_SHELL_PATH__";
let pending: Promise<void> | undefined;

/** The PATH folders a login shell printed between the two marks, or none when it printed no PATH. */
export function parseShellPath(output: string): string[] {
  const line = output
    .split(MARK)[1]
    ?.split("\n")
    .find((entry) => entry.startsWith("PATH="));
  return line ? line.slice(5).split(":").filter(Boolean) : [];
}

function readLoginShell(shell: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      shell,
      ["-ilc", `echo ${MARK}; /usr/bin/env; echo ${MARK}`],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/**
 * Adds the student's login-shell PATH (nvm, Homebrew, ~/.local/bin set up in .zshrc) to core's PATH, once per launch
 * and without blocking. CLI Funnel would otherwise run `$SHELL -ilc` synchronously on its first lookup, which held
 * core's startup for as long as the shell took. Provider detection waits for this through `shellPathReady()`.
 */
export function loadShellPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  timeoutMs = 5000,
): Promise<void> {
  if (pending) return pending;
  // Windows has no login shell to ask, and a launch that opted out (tests) keeps the PATH it has.
  if (platform === "win32" || env.CLI_FUNNEL_NO_SHELL_PATH === "1") {
    pending = Promise.resolve();
    return pending;
  }
  env.CLI_FUNNEL_NO_SHELL_PATH = "1";
  const shell = env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  pending = readLoginShell(shell, timeoutMs).then((output) => {
    const current = (env.PATH ?? "").split(":").filter(Boolean);
    env.PATH = [...new Set([...current, ...parseShellPath(output)])].join(":");
  });
  return pending;
}

/** Resolves once the login-shell PATH is in place, at once when nothing started loading it. */
export function shellPathReady(): Promise<void> {
  return pending ?? Promise.resolve();
}

/** Tests start from a clean slate. */
export function resetShellPath(): void {
  pending = undefined;
}
