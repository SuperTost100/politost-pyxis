import { _electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";

/**
 * A launch that fails after Electron has started closes the app, since the caller never gets it to close. The trace is
 * started after the window is sized, and it creates a folder in the temporary folder of the test's own process: with that
 * folder gone it rejects, and the app must not be left running.
 */
test("a trace that cannot start leaves no app running", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-launch-guard-"));
  const real = _electron.launch.bind(_electron);
  let started: ElectronApplication | undefined;
  let pid = 0;
  const saved = { trace: process.env.PYXIS_TRACE, TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  const good = tmpdir();
  // The app is started with a usable temporary folder, and the process that starts the trace gets one that does not
  // exist from the moment the app is up, before `launchPyxis` goes on to the trace.
  _electron.launch = async (options) => {
    started = await real(options);
    pid = started.process().pid!;
    for (const name of ["TMPDIR", "TMP", "TEMP"] as const) process.env[name] = join(good, "pyxis-no-such-folder");
    return started;
  };
  try {
    process.env.PYXIS_TRACE = "1";
    await expect(launchPyxis({ userData, env: { TMPDIR: good, TMP: good, TEMP: good } })).rejects.toThrow();
    const running = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await expect.poll(running, { timeout: 30_000 }).toBe(false);
  } finally {
    _electron.launch = real;
    for (const [name, value] of Object.entries({ PYXIS_TRACE: saved.trace, TMPDIR: saved.TMPDIR, TMP: saved.TMP, TEMP: saved.TEMP })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await started?.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});
