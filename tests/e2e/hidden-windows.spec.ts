import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { drawingPinned, stagePacks } from "./drawing-packs";

// The windows that run work for the app (the drawing window, the Python window) are hidden, and they stay open after
// they have answered so the next request finds them ready. The app is still its main window: closing that window ends
// the app on Windows and Linux, and brings it back on macOS, whatever hidden windows are left.

const GRAPH = "digraph { a -> b -> c }";

type Handle = { draw: (payload: unknown) => Promise<{ image?: string; error?: string }>; windows: () => number[] };
const drawing = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { pyxisE2eDraw: Handle }).pyxisE2eDraw.windows());

async function mainWindowClosed(app: ElectronApplication, page: Page) {
  const exited = app.waitForEvent("close", { timeout: 20_000 });
  const main = await app.browserWindow(page);
  await main.evaluate((window) => window.close());
  return exited;
}

test("closing the main window after a graph was drawn ends the app, with the drawing window still open", async () => {
  test.skip(!drawingPinned(), "Requires the pinned drawing fixtures in .tmp/drawing.");
  test.skip(process.platform === "darwin", "macOS keeps the app open after its last window; the decision is in main-window.ts and its unit test.");
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-hidden-windows-"));
  stagePacks(userData, ["drawing"]);
  const app = await launchPyxis({ userData, env: { HOME: userData } });
  let exited = false;
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const drawn = await app.evaluate((_, payload) => (globalThis as unknown as { pyxisE2eDraw: Handle }).pyxisE2eDraw.draw(payload), {
      kind: "graph",
      code: GRAPH,
    });
    expect(drawn).toHaveProperty("image");
    // The drawing window is open, hidden, waiting for the next drawing.
    expect(await drawing(app)).toHaveLength(1);
    await mainWindowClosed(app, page);
    exited = true;
  } finally {
    if (!exited) await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});

test("closing the main window of an app that opened no hidden window ends it", async () => {
  test.skip(process.platform === "darwin", "macOS keeps the app open after its last window.");
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-hidden-windows-"));
  const app = await launchPyxis({ userData });
  let exited = false;
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await mainWindowClosed(app, page);
    exited = true;
  } finally {
    if (!exited) await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});

test("closing the main window after Python ran ends the app, with the Python window still open", async () => {
  test.skip(!existsSync(".tmp/pyodide/pyodide.js"), "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.");
  test.skip(process.platform === "darwin", "macOS keeps the app open after its last window.");
  test.setTimeout(180_000);
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "resources/pyodide-manifest.json"), "utf8")) as { version: string };
  const userData = mkdtempSync(join(tmpdir(), "pyxis-hidden-windows-"));
  const pack = join(userData, "workspace/runtimes/pyodide", manifest.version);
  mkdirSync(pack, { recursive: true });
  cpSync(join(process.cwd(), ".tmp/pyodide"), pack, { recursive: true });
  const app = await launchPyxis({ userData });
  let exited = false;
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const ran = (await page.evaluate(() => window.pyxis.invoke("tools.python", { code: "print(6 * 7)" }))) as { stdout: string };
    expect(ran.stdout).toContain("42");
    const windows = await app.evaluate(() => (globalThis as unknown as { pyxisE2ePython: { windows: () => number[] } }).pyxisE2ePython.windows());
    expect(windows).toHaveLength(1);
    await mainWindowClosed(app, page);
    exited = true;
  } finally {
    if (!exited) await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});

test("on macOS, closing the main window leaves the app and its Python window open, and an activation makes one main window", async () => {
  test.skip(process.platform !== "darwin", "The Mac half of the defect: Windows and Linux end the app with the main window, as the tests above show.");
  test.skip(!existsSync(".tmp/pyodide/pyodide.js"), "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.");
  test.setTimeout(180_000);
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "resources/pyodide-manifest.json"), "utf8")) as { version: string };
  const userData = mkdtempSync(join(tmpdir(), "pyxis-hidden-windows-"));
  const pack = join(userData, "workspace/runtimes/pyodide", manifest.version);
  mkdirSync(pack, { recursive: true });
  cpSync(join(process.cwd(), ".tmp/pyodide"), pack, { recursive: true });
  const app = await launchPyxis({ userData });
  const mainWindows = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => window.webContents.getURL().startsWith("pyxis-app://app/index.html")).length);
  const hiddenWindows = () =>
    app.evaluate(() => (globalThis as unknown as { pyxisE2ePython: { windows: () => number[] } }).pyxisE2ePython.windows().length);
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const ran = (await page.evaluate(() => window.pyxis.invoke("tools.python", { code: "print(6 * 7)" }))) as { stdout: string };
    expect(ran.stdout).toContain("42");
    expect(await hiddenWindows()).toBe(1);
    // The main window closes, and the app stays, with its hidden window and no main window.
    const main = await app.browserWindow(page);
    await main.evaluate((window) => window.close());
    await expect.poll(mainWindows).toBe(0);
    expect(app.process().exitCode).toBeNull();
    expect(await hiddenWindows()).toBe(1);
    // The dock icon is clicked: one main window, which shows the app. The hidden window is not taken for it.
    await app.evaluate(({ app: electron }) => electron.emit("activate"));
    await expect.poll(mainWindows, { timeout: 30_000 }).toBe(1);
    const again = app.windows().find((window) => window.url().startsWith("pyxis-app://app/index.html"))!;
    await expect(again.getByRole("navigation", { name: "Sezioni" })).toBeVisible({ timeout: 30_000 });
    // A second click makes none.
    await app.evaluate(({ app: electron }) => electron.emit("activate"));
    expect(await mainWindows()).toBe(1);
    expect(await hiddenWindows()).toBe(1);
  } finally {
    await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});

test("an activation while the old profile's settings are being copied makes no second main window", async () => {
  test.setTimeout(120_000);
  // A profile whose window an earlier version saved, and no record of a copy: startup opens a hidden window to copy
  // what the renderer stored, and makes the main window when that is done. The test holds startup after the copy, with
  // the hidden window still open, and activates the app there as macOS does.
  const userData = mkdtempSync(join(tmpdir(), "pyxis-activate-"));
  writeFileSync(join(userData, "window.json"), JSON.stringify({ width: 1280, height: 832 }));
  const marker = join(userData, "storage-carried.json");
  const hold = join(userData, "first-window-hold");
  writeFileSync(hold, "");
  const app = await launchPyxis({ userData, packaged: false, env: { PYXIS_E2E_FIRST_WINDOW_HOLD: hold } });
  const mainWindows = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => window.webContents.getURL().startsWith("pyxis-app://app/index.html")).length);
  try {
    // The copy is over and recorded, and the main window is waiting on the hold: only the hidden window exists.
    await expect.poll(() => existsSync(marker), { timeout: 30_000 }).toBe(true);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await app.evaluate(({ app: electron }) => electron.emit("activate"));
    // Startup makes the first window itself: the activation made none.
    expect(await mainWindows()).toBe(0);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    rmSync(hold);
    await expect.poll(mainWindows, { timeout: 30_000 }).toBe(1);
    // Exactly one: a second one would have been made with it, or by the activation.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});
