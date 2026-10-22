import { _electron as electron, type ElectronApplication } from "@playwright/test";
import { join } from "node:path";

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
export function launchPyxis({
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
  return electron.launch(
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
}
