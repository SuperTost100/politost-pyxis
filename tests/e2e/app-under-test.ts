import { _electron as electron, test, type ElectronApplication, type TestInfo } from "@playwright/test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { withoutLaunchEnvironment } from "./trace-clean";
import { saveTrace } from "./trace-save";
import { removeTestFolder } from "./cleanup";

export type LaunchOptions = {
  /** The profile folder, passed as PYXIS_USER_DATA. */
  userData: string;
  /** Variables on top of this process's environment. `undefined` removes one the test runner has. */
  env?: Record<string, string | undefined>;
  /** Command-line arguments after the app, such as a plan file to open. */
  args?: string[];
  /** The packaged executable to run. Defaults to PYXIS_DIST_APP; `false` always runs the build in out/. */
  packaged?: string | false;
};

/**
 * Starts Pyxis for a test with its seams on (PYXIS_E2E) and its own profile. Runs the packaged executable named in
 * PYXIS_DIST_APP (CI's packaging job), or else the unpackaged build in out/ (PYXIS_OUT overrides the folder).
 */
export async function launchPyxis({
  userData,
  env = {},
  args = [],
  packaged = process.env.PYXIS_DIST_APP,
}: LaunchOptions): Promise<ElectronApplication> {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    ...env,
    // A runner started under Electron's Node (npm test, some editors) has this set, and the app must start as Electron.
    ELECTRON_RUN_AS_NODE: undefined,
  };
  // Node's spawn leaves out unset variables anyway; Playwright's type wants them gone.
  const set = Object.fromEntries(
    Object.entries(merged).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const app = await electron.launch(
    packaged
      ? {
          executablePath: packaged,
          args: ["--use-mock-keychain", ...args],
          env: set,
        }
      : {
          args: [
            join(process.cwd(), process.env.PYXIS_OUT ?? "out", "main/index.js"),
            ...args,
          ],
          env: set,
        },
  );
  try {
    await sizeWindow(app, set.PYXIS_E2E_WINDOW);
    if (tracing()) await traceUntilClosed(app);
  } catch (error) {
    // The caller never gets this app, so nobody else can close it, and on Windows its open database would make the
    // test's cleanup fail and hide this error.
    await app.close().catch(() => undefined);
    throw error;
  }
  return app;
}

/** Off unless `PYXIS_TRACE=1`, which the macOS test jobs of `full.yml` set: it costs about 10 to 25 % of a short spec. */
const tracing = () => process.env.PYXIS_TRACE === "1";

/** A trace bigger than this is not kept, so a long test cannot fill the failed job's artifact. */
const TRACE_MAX_BYTES = 30 * 1024 * 1024;

let launches = 0;

/**
 * Records a Playwright trace of the app's windows (actions, console and a screenshot of each step, no DOM snapshots) and
 * saves it when the test closes the app, as an attachment `trace-<n>` of the test. Playwright's own `trace` option does
 * not reach an app that a spec launches itself. `scripts/keep-failed-traces.ts` deletes the traces of the tests that
 * passed, so only a failed test leaves one behind.
 */
async function traceUntilClosed(app: ElectronApplication) {
  const context = app.context();
  const number = ++launches;
  // The test that launched the app, kept for the close that comes after the test has timed out: its `finally` then runs once
  // Playwright has finished the test, when `test.info()` throws, and the test that timed out is the one whose trace is wanted.
  const launchedBy = test.info();
  await context.tracing.start({ screenshots: true, snapshots: false });
  const close = app.close.bind(app);
  app.close = async () => {
    try {
      const running = runningTest();
      await saveTrace({
        stop: (path) => context.tracing.stop({ path }),
        // A test that is over cannot take an attachment: its trace goes into its output folder, which the failed job uploads.
        attach: async (path) => {
          if (running) await running.attach(`trace-${number}`, { path, contentType: "application/zip" });
          else copyFileSync(path, launchedBy.outputPath(`trace-${number}.zip`));
        },
        maxBytes: TRACE_MAX_BYTES,
        clean: withoutLaunchEnvironment,
      });
    } catch (error) {
      // A trace that cannot be saved must not fail the test that asked for the app to close, and one that could not be
      // cleaned of the launch's environment is not kept.
      console.error(`trace ${number} not saved: ${(error as Error).message}`);
    }
    await close();
  };
}

/** The test that is running, or undefined once it is over (it timed out, and its code is still unwinding). */
function runningTest(): TestInfo | undefined {
  try {
    return test.info();
  } catch {
    return undefined;
  }
}

/**
 * Runs the setup steps of a spec that come after `launchPyxis` (the window, setup, seeding). When one throws, the caller
 * never gets the app, so nobody else can close it or remove its folder: this closes the app, removes `folder` (the
 * profile, or the folder that holds it) and throws the setup's own error again. A cleanup that fails too is reported
 * on the console and does not hide that error.
 */
export async function setUp<T>(app: ElectronApplication, folder: string, steps: () => Promise<T>): Promise<T> {
  try {
    return await steps();
  } catch (error) {
    await app.close().catch(() => undefined);
    try {
      removeTestFolder(folder);
    } catch (leftover) {
      console.error(`setUp: ${folder} was not removed: ${(leftover as Error).message}`);
    }
    throw error;
  }
}

/**
 * PYXIS_E2E_WINDOW=1024x640 sizes the first window's content area to that, as a smaller screen would: a Windows runner
 * shows 1024 px of desktop and clamps the 1280 px default. The app does not go below 960x640 either way. Writing a
 * window.json into the profile does not work: the app closed right after launch when one was there. The size is read
 * from the environment the app was started with, so a test can set or remove it through `LaunchOptions.env`.
 */
async function sizeWindow(app: ElectronApplication, size: string | undefined) {
  const match = /^(\d+)x(\d+)$/.exec(size ?? "");
  if (!match) return;
  await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, [width, height]) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(width, height);
  }, [Number(match[1]), Number(match[2])] as const);
}
