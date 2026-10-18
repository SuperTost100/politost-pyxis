import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadShellPath,
  parseShellPath,
  resetShellPath,
  shellPathReady,
} from "./shell-path";

const dirs: string[] = [];
afterEach(() => {
  resetShellPath();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A login shell that takes `seconds` to start, like zsh with nvm, and then prints its environment. */
function slowShell(seconds: number, path: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-shell-"));
  dirs.push(dir);
  const shell = join(dir, "slow-sh");
  writeFileSync(
    shell,
    `#!/bin/sh\nsleep ${seconds}\nexport PATH="${path}"\nexec /bin/sh -c "$2"\n`,
  );
  chmodSync(shell, 0o755);
  return shell;
}

describe("login shell PATH", () => {
  it("reads PATH between the marks only", () => {
    const out = "motd PATH=/nope\n__PYXIS_SHELL_PATH__\nHOME=/h\nPATH=/a:/b::/c\n__PYXIS_SHELL_PATH__\n";
    expect(parseShellPath(out)).toEqual(["/a", "/b", "/c"]);
    expect(parseShellPath("no marks")).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "adds the shell's folders in the background, without holding up the caller",
    async () => {
      const env: NodeJS.ProcessEnv = {
        PATH: "/usr/bin:/bin",
        SHELL: slowShell(0.5, "/opt/nvm/bin:/usr/bin:/bin"),
      };
      const started = Date.now();
      const loading = loadShellPath(env, "linux");
      // The call returns at once; CLI Funnel is told not to run its own blocking lookup.
      expect(Date.now() - started).toBeLessThan(100);
      expect(env.CLI_FUNNEL_NO_SHELL_PATH).toBe("1");
      expect(env.PATH).toBe("/usr/bin:/bin");
      await shellPathReady();
      await loading;
      expect(Date.now() - started).toBeGreaterThanOrEqual(400);
      expect(env.PATH).toBe("/usr/bin:/bin:/opt/nvm/bin");
      // Once per launch: a second call reuses the first.
      expect(loadShellPath(env, "linux")).toBe(loading);
    },
  );

  it("keeps the PATH it has on Windows, after an opt-out, and when the shell fails", async () => {
    const windows: NodeJS.ProcessEnv = { PATH: "C:\\bin" };
    await loadShellPath(windows, "win32");
    expect(windows).toEqual({ PATH: "C:\\bin" });
    resetShellPath();
    const opted: NodeJS.ProcessEnv = { PATH: "/bin", CLI_FUNNEL_NO_SHELL_PATH: "1" };
    await loadShellPath(opted, "linux");
    expect(opted.PATH).toBe("/bin");
    resetShellPath();
    const broken: NodeJS.ProcessEnv = { PATH: "/bin", SHELL: "/no/such/shell" };
    await loadShellPath(broken, "linux");
    expect(broken.PATH).toBe("/bin");
  });

  it("is ready at once when nothing started loading it", async () => {
    await expect(shellPathReady()).resolves.toBeUndefined();
  });
});
