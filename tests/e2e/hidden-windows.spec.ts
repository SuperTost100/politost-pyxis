import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";

// The Python window is hidden, and it stays open after it has answered so the next run finds it ready. The app is still
// its main window: closing that window ends the app on Windows and Linux, and brings it back on macOS, whatever hidden
// window is left.

const manifest = JSON.parse(readFileSync(join(process.cwd(), "resources/pyodide-manifest.json"), "utf8")) as {
  version: string;
};
const pyodidePinned = () => existsSync(".tmp/pyodide/pyodide.js");

/** A profile with the pinned Python runtime already installed. */
function profileWithPython(): string {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-hidden-windows-"));
  const pack = join(userData, "workspace/runtimes/pyodide", manifest.version);
  mkdirSync(pack, { recursive: true });
  cpSync(join(process.cwd(), ".tmp/pyodide"), pack, { recursive: true });
  return userData;
}

async function skipSetup(page: Page) {
  await page.getByRole("button", { name: "Salta" }).click();
  await expect(page).toHaveURL(/#\/exams$/);
}

async function runPython(page: Page) {
  const ran = (await page.evaluate(() => window.pyxis.invoke("tools.python", { code: "print(6 * 7)" }))) as {
    stdout: string;
  };
  expect(ran.stdout).toContain("42");
}

const allWindows = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const mainWindows = (app: ElectronApplication) =>
  app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter((window) => window.webContents.getURL().startsWith("pyxis-app://app/index.html"))
        .length,
  );

async function closeMainWindow(app: ElectronApplication, page: Page) {
  const exited = app.waitForEvent("close", { timeout: 20_000 });
  const main = await app.browserWindow(page);
  await main.evaluate((window) => window.close());
  await exited;
}

test("closing the main window after Python ran ends the app, with the Python window still open", async () => {
  test.skip(!pyodidePinned(), "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.");
  test.skip(process.platform === "darwin", "macOS keeps the app open after its main window; see the macOS test below.");
  test.setTimeout(180_000);
  const userData = profileWithPython();
  const app = await launchPyxis({ userData });
  let exited = false;
  try {
    const page = await app.firstWindow();
    await skipSetup(page);
    await runPython(page);
    // The main window and the hidden Python window, waiting for the next run.
    expect(await allWindows(app)).toBe(2);
    await closeMainWindow(app, page);
    exited = true;
  } finally {
    if (!exited) await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});

test("closing the main window of an app that opened no hidden window ends it", async () => {
  test.skip(process.platform === "darwin", "macOS keeps the app open after its main window.");
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-hidden-windows-"));
  const app = await launchPyxis({ userData });
  let exited = false;
  try {
    const page = await app.firstWindow();
    await skipSetup(page);
    expect(await allWindows(app)).toBe(1);
    await closeMainWindow(app, page);
    exited = true;
  } finally {
    if (!exited) await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});

test("on macOS, closing the main window after Python ran keeps the app, and an activation makes one main window", async () => {
  test.skip(process.platform !== "darwin", "Windows and Linux end the app with its main window, as the tests above show.");
  test.skip(!pyodidePinned(), "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.");
  test.setTimeout(180_000);
  const userData = profileWithPython();
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await skipSetup(page);
    await runPython(page);
    expect(await allWindows(app)).toBe(2);
    // The main window closes, and the app stays with its hidden window and no main window.
    const main = await app.browserWindow(page);
    await main.evaluate((window) => window.close());
    await expect.poll(() => mainWindows(app)).toBe(0);
    expect(app.process().exitCode).toBeNull();
    expect(await allWindows(app)).toBe(1);
    // The dock icon is clicked: the hidden window is not taken for the main one, so one main window is made.
    await app.evaluate(({ app: electron }) => electron.emit("activate"));
    await expect.poll(() => mainWindows(app), { timeout: 30_000 }).toBe(1);
    const again = app.windows().find((window) => window.url().startsWith("pyxis-app://app/index.html"))!;
    await expect(again.getByRole("navigation", { name: "Sezioni" })).toBeVisible({ timeout: 30_000 });
    // A second click makes none.
    await app.evaluate(({ app: electron }) => electron.emit("activate"));
    expect(await mainWindows(app)).toBe(1);
    expect(await allWindows(app)).toBe(2);
  } finally {
    await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});
