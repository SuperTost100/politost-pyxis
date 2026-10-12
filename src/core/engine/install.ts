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
        // By full path, so a powershell.exe in the working folder is never picked up.
        win32.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
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
    // On macOS and Linux the installer leads its own process group, so stopping it also stops curl and the vendor
    // script. Otherwise they keep the output pipes open and the install looks like it never ends.
    const child = spawn(file, args, {
      env: { ...process.env, CODEX_NON_INTERACTIVE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: platform !== "win32",
    });
    let log = "";
    let stopped: "cancelled" | "timeout" | null = null;
    let settled = false;
    const take = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      log = (log + text).slice(-LOG_LIMIT);
      options.onLog?.(text);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const stopTree = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      if (platform === "win32") {
        spawn(
          win32.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "taskkill.exe",
          ),
          ["/pid", String(child.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true },
        ).once("error", () => child.kill());
        return;
      }
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    const timer = setTimeout(() => {
      stopped = "timeout";
      stopTree();
    }, TIMEOUT_MS);
    const cancel = () => {
      stopped = "cancelled";
      stopTree();
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      const tail = log.trim().split("\n").slice(-3).join(" ");
      // A clean exit wins over a cancel that arrived too late to stop it.
      if (code === 0) resolve();
      else if (stopped === "cancelled")
        reject(new DOMException("Install cancelled", "AbortError"));
      else if (stopped === "timeout")
        reject(new Error(`installer timed out after 10 minutes: ${tail}`));
      else
        reject(
          new Error(`installer exited with ${code ?? "a signal"}: ${tail}`),
        );
    };
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    // Once stopped, settle when the installer itself exits, without waiting for pipes a stray child may hold.
    child.once("exit", (code) => {
      if (stopped) {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code);
      }
    });
    child.once("close", (code) => finish(code));
  });
}
