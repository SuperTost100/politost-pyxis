import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { win32 } from "node:path";
import {
  installCommand,
  isInstallable,
  type InstallableProvider,
} from "../../shared/installers";

export { isInstallable, type InstallableProvider };

function spawnArgs(
  provider: InstallableProvider,
  platform: NodeJS.Platform,
): [string, string[]] {
  return platform === "win32"
    ? [
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          installCommand(provider, platform),
        ],
      ]
    : [
        "/bin/bash",
        ["-c", `set -o pipefail; ${installCommand(provider, platform)}`],
      ];
}

/**
 * Folders the installers write to. Codex, Cursor and Antigravity add theirs to the user PATH on Windows, but a process
 * that is already running never sees that change, so core adds them itself. On macOS and Linux they all use
 * `~/.local/bin`, which CLI Funnel already searches.
 */
export function installDirs(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  if (platform !== "win32") return [];
  const { join } = win32;
  const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  return [
    join(home, ".local", "bin"),
    join(local, "Programs", "OpenAI", "Codex", "bin"),
    join(local, "cursor-agent"),
    join(local, "agy", "bin"),
  ];
}

/** Appends the install folders to PATH once, so a CLI installed while Pyxis runs is found without a restart. */
export function addInstallDirsToPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  // Only Windows needs extra folders, and its PATH is case-insensitive and separated by semicolons.
  const dirs = installDirs(platform, env);
  if (!dirs.length) return;
  const key =
    Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "Path";
  const current = (env[key] ?? "").split(";").filter(Boolean);
  const seen = new Set(current.map((dir) => dir.toLowerCase()));
  const missing = dirs.filter((dir) => !seen.has(dir.toLowerCase()));
  if (missing.length) env[key] = [...current, ...missing].join(";");
}

const TIMEOUT_MS = 10 * 60_000;
const LOG_LIMIT = 64_000;

/**
 * Runs the vendor installer and resolves when it exits successfully. Output lines go to `onLog` as they arrive.
 * The installer gets no input: a script that stops to ask a question reads end-of-file and fails rather than hanging.
 */
export function runInstaller(
  provider: InstallableProvider,
  options: {
    onLog?: (text: string) => void;
    signal?: AbortSignal;
    platform?: NodeJS.Platform;
    /** Tests replace the vendor command. */
    command?: [string, string[]];
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const [file, args] = options.command ?? spawnArgs(provider, platform);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: { ...process.env, CODEX_NON_INTERACTIVE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let log = "";
    const take = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      log = (log + text).slice(-LOG_LIMIT);
      options.onLog?.(text);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const stop = () => child.kill();
    const timer = setTimeout(stop, TIMEOUT_MS);
    options.signal?.addEventListener("abort", stop, { once: true });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      if (options.signal?.aborted)
        reject(new DOMException("Install cancelled", "AbortError"));
      else if (code === 0) resolve();
      else
        reject(
          new Error(
            `installer exited with ${code ?? "a signal"}: ${log.trim().split("\n").slice(-3).join(" ")}`,
          ),
        );
    });
  });
}
