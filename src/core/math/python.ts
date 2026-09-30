import { spawn } from "node:child_process";

// ponytail: this machine's python3 with a socket stub and a hard kill.
// Upgrade path is the Pyodide worker in implementation 3.9.

const PREAMBLE = `
import builtins
_pyxis_import = builtins.__import__
def _pyxis_guard(name, *args, **kwargs):
    mod = _pyxis_import(name, *args, **kwargs)
    if name == "socket":
        def _blocked(*_a, **_k):
            raise OSError("network blocked")
        real = mod.socket
        class _Guard(real):
            def connect(self, *_a, **_k):
                raise OSError("network blocked")
            def connect_ex(self, *_a, **_k):
                raise OSError("network blocked")
        mod.socket = _Guard
        mod.create_connection = _blocked
    return mod
builtins.__import__ = _pyxis_guard
`;

export function runPython(
  code: string,
  timeoutMs = 10_000,
): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-I", "-c", PREAMBLE + "\n" + code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut });
    });
  });
}
