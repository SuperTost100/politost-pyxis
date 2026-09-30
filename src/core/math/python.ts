import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

// ponytail: macOS sandbox-exec denies the network for this process tree.
// Upgrade path is the Pyodide worker in implementation 3.9, which does not need a system Python.

const CAP = 200_000;

const PROFILE = `
(version 1)
(deny default)
(allow process-fork)
(allow process-exec)
(allow signal)
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow file-read*)
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "/private/var/folders"))
(deny network*)
`;

export type PythonRun = {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

export function runPython(code: string, timeoutMs = 10_000): Promise<PythonRun> {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
    return Promise.resolve({
      stdout: "",
      stderr: "python-sandbox-missing",
      timedOut: false,
      truncated: false,
    });
  }
  return new Promise((resolve) => {
    const child = spawn(
      "/usr/bin/sandbox-exec",
      ["-p", PROFILE, "python3", "-I", "-c", code],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    const stop = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const take = (current: string, chunk: string) => {
      if (current.length >= CAP) {
        truncated = true;
        stop();
        return current;
      }
      const next = current + chunk;
      if (next.length <= CAP) return next;
      truncated = true;
      stop();
      return next.slice(0, CAP);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = take(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = take(stderr, chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({
        stdout: "",
        stderr: "python-missing",
        timedOut: false,
        truncated: false,
      });
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, truncated });
    });
  });
}
