import { describe, expect, it } from "vitest";
import { installCommand } from "../../shared/installers";
import { addInstallDirsToPath, installDirs, runInstaller } from "./install";

const node = process.execPath;

describe("installCommand", () => {
  it("names the vendor's own script for each platform", () => {
    expect(installCommand("claude", "darwin")).toBe(
      "curl -fsSL 'https://claude.ai/install.sh' | bash",
    );
    expect(installCommand("agent", "win32")).toBe(
      "irm 'https://cursor.com/install?win32=true' | iex",
    );
  });
});

describe("addInstallDirsToPath", () => {
  it("adds the Windows install folders once, keeping the existing PATH first", () => {
    const env: NodeJS.ProcessEnv = {
      Path: "C:\\Windows;C:\\Users\\ada\\.local\\bin",
      LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
    };
    addInstallDirsToPath(env, "win32");
    addInstallDirsToPath(env, "win32");
    const dirs = env.Path!.split(";");
    expect(dirs.slice(0, 2)).toEqual([
      "C:\\Windows",
      "C:\\Users\\ada\\.local\\bin",
    ]);
    expect(dirs.filter((dir) => /agy/.test(dir))).toHaveLength(1);
    expect(env.PATH).toBeUndefined();
  });

  it("leaves PATH alone on macOS and Linux, where CLI Funnel already searches ~/.local/bin", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    addInstallDirsToPath(env, "linux");
    expect(env.PATH).toBe("/usr/bin");
    expect(installDirs("darwin")).toEqual([]);
  });
});

describe("runInstaller", () => {
  it("streams the output and resolves when the installer succeeds", async () => {
    const lines: string[] = [];
    await runInstaller("claude", {
      command: [node, ["-e", "console.log('Installed claude')"]],
      onLog: (text) => lines.push(text),
    });
    expect(lines.join("")).toContain("Installed claude");
  });

  it("rejects with the last lines when the installer fails", async () => {
    await expect(
      runInstaller("codex", {
        command: [
          node,
          [
            "-e",
            "console.error('curl: (6) Could not resolve host'); process.exit(6)",
          ],
        ],
      }),
    ).rejects.toThrow(/exited with 6: curl: \(6\) Could not resolve host/);
  });

  it("gives the installer no input, so a question cannot hang it", async () => {
    await expect(
      runInstaller("agent", {
        command: [
          node,
          [
            "-e",
            "process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(3))",
          ],
        ],
      }),
    ).rejects.toThrow(/exited with 3/);
  });

  it("stops the installer when cancelled", async () => {
    const abort = new AbortController();
    const run = runInstaller("antigravity", {
      command: [node, ["-e", "setTimeout(() => {}, 60000)"]],
      signal: abort.signal,
    });
    abort.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });
});
