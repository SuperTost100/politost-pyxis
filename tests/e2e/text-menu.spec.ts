import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams, toLibrary } from "./doors";
import { answerNextMenu, lastMenuItems, lastMenuLabels, type MenuItemShown } from "./native-menu";
import { seedSource } from "./seed";

/**
 * A right-click on text opens the system's edit menu, which main builds from the window's `context-menu` event: a test
 * can't click a native menu, so it reads the items main asked the system to show (the same stand-in the chat menus use).
 * The labels and what is on follow the field the click was on, in the app's language.
 */
async function textMenuOf(app: ElectronApplication, target: Locator, options: { button?: "right" } = {}) {
  await answerNextMenu(app, null);
  await target.click({ button: "right", ...options });
  await expect.poll(() => lastMenuItems(app)).toBeDefined();
  return (await lastMenuItems(app))!;
}

const labelsOf = (items: MenuItemShown[]) => items.map((item) => (item === "-" ? "-" : item.label));
const offIn = (items: MenuItemShown[]) => items.flatMap((item) => (item !== "-" && !item.enabled ? [item.label] : []));

/** How many times the window's `context-menu` event came, which only a right-click Chromium offers the system counts. */
async function countContextMenus(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }) => {
    const shown = globalThis as unknown as { contextMenuEvents?: number };
    shown.contextMenuEvents = 0;
    BrowserWindow.getAllWindows()[0]!.webContents.on("context-menu", () => {
      shown.contextMenuEvents = (shown.contextMenuEvents ?? 0) + 1;
    });
  });
  return () => app.evaluate(() => (globalThis as unknown as { contextMenuEvents?: number }).contextMenuEvents ?? 0);
}

/** Puts a field of each kind the app has but does not always show on the page, as the real ones are drawn. */
async function addProbeFields(page: Page) {
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "probe-fields";
    host.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:99999;display:grid;gap:4px;background:#fff;padding:4px";
    host.innerHTML = `
      <input id="probe-password" type="password" aria-label="Probe password" value="segreto">
      <input id="probe-readonly" readonly aria-label="Probe read-only" value="solo lettura">
      <textarea id="probe-readonly-area" readonly aria-label="Probe read-only area">solo lettura</textarea>
      <div id="probe-formula" contenteditable="true" role="textbox" aria-label="Probe formula">x^2 + 1</div>
      <p id="probe-text">Il calore si trasmette per conduzione.</p>`;
    document.body.append(host);
  });
}

async function start(env: Record<string, string | undefined> = {}) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-text-menu-"));
  const app = await launchPyxis({ userData, env });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 832 });
  await page.getByRole("button", { name: /^(Salta|Skip)$/ }).click();
  await fromChiediToExams(page);
  await page.evaluate(() => window.pyxis.invoke("subjects.add", { name: "Analisi 1" }));
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  seedSource(db, { id: "s1", title: "Appunti di fisica", document: { id: "d1" }, passages: [] });
  db.close();
  await toLibrary(page);
  return { app, page, userData };
}

test("A right-click in any text field opens the edit menu in Italian, with each item on only when it applies", async () => {
  test.setTimeout(180_000);
  const { app, page, userData } = await start();
  try {
    const events = await countContextMenus(app);
    // A single-line field with nothing in it: there is nothing to undo, cut or copy, and Seleziona tutto has nothing to select.
    const search = page.getByRole("textbox").first();
    const empty = await textMenuOf(app, search);
    expect(labelsOf(empty)).toEqual(["Annulla", "Ripeti", "-", "Taglia", "Copia", "Incolla", "-", "Seleziona tutto"]);
    expect(empty.flatMap((item) => (item !== "-" ? [item.role] : []))).toEqual(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
    expect(offIn(empty)).toEqual(expect.arrayContaining(["Taglia", "Copia"]));
    expect(await events()).toBe(1);

    // With text selected, Taglia and Copia are on.
    await search.fill("heat");
    await search.press("ControlOrMeta+a");
    const selected = await textMenuOf(app, search);
    expect(labelsOf(selected)).toEqual(labelsOf(empty));
    expect(offIn(selected)).not.toEqual(expect.arrayContaining(["Taglia"]));
    expect(offIn(selected)).not.toEqual(expect.arrayContaining(["Copia"]));
    expect(offIn(selected)).not.toEqual(expect.arrayContaining(["Seleziona tutto"]));

    // The multi-line chat composer.
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    const composer = page.getByRole("textbox", { name: "Messaggio" });
    await expect(composer).toBeVisible();
    expect(labelsOf(await textMenuOf(app, composer))).toEqual(labelsOf(empty));

    // The kinds a page does not always show: a password field has no Taglia or Copia, a read-only one has Copia and
    // Seleziona tutto, a formula's editable text is a field, and selected text outside a field has Copia.
    await addProbeFields(page);
    expect(labelsOf(await textMenuOf(app, page.locator("#probe-password")))).toEqual(["Annulla", "Ripeti", "-", "Incolla", "-", "Seleziona tutto"]);
    expect(labelsOf(await textMenuOf(app, page.locator("#probe-readonly")))).toEqual(["Copia", "Seleziona tutto"]);
    expect(labelsOf(await textMenuOf(app, page.locator("#probe-readonly-area")))).toEqual(["Copia", "Seleziona tutto"]);
    expect(labelsOf(await textMenuOf(app, page.locator("#probe-formula")))).toEqual(labelsOf(empty));
    await page.evaluate(() => getSelection()!.selectAllChildren(document.querySelector("#probe-text")!));
    expect(labelsOf(await textMenuOf(app, page.locator("#probe-text")))).toEqual(["Copia"]);
    // Text that is not selected has no menu: nothing is shown.
    await page.evaluate(() => getSelection()!.removeAllRanges());
    await answerNextMenu(app, null);
    await page.locator("#probe-text").click({ button: "right" });
    await expect.poll(events).toBeGreaterThan(5);
    expect(await lastMenuLabels(app)).toBeUndefined();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("The app's own right-click menus stay as they are, and a field inside one gets the text menu", async () => {
  test.setTimeout(180_000);
  const { app, page, userData } = await start();
  try {
    const events = await countContextMenus(app);
    // A file's row in Da sistemare answers with the app's menu, in the page: the page prevents the right-click, and
    // Chromium then sends the window no `context-menu` event.
    const row = page.locator(".px-unsorted-row", { hasText: "Appunti di fisica" });
    await answerNextMenu(app, null);
    await row.click({ button: "right", position: { x: 30, y: 30 } });
    await expect(page.getByRole("menuitem", { name: "Sposta in", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    // The subject's card and its covers too.
    const subject = page.getByRole("region", { name: /^Analisi 1 / });
    await subject.getByRole("heading", { level: 2 }).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Rinomina" })).toBeVisible();
    expect(await events()).toBe(0);
    expect(await lastMenuLabels(app)).toBeUndefined();

    // The rename field inside the subject's card is a field: a right-click there gets the text menu, not the card's.
    await page.keyboard.press("Escape");
    await subject.getByRole("heading", { level: 2 }).dblclick();
    const field = page.getByRole("textbox", { name: "Nome della materia Analisi 1" });
    await expect(field).toBeFocused();
    await answerNextMenu(app, null);
    await field.click({ button: "right" });
    await expect.poll(() => lastMenuItems(app)).toBeDefined();
    expect(labelsOf((await lastMenuItems(app))!)).toEqual(["Annulla", "Ripeti", "-", "Taglia", "Copia", "Incolla", "-", "Seleziona tutto"]);
    expect(await events()).toBe(1);
    await expect(page.getByRole("menu")).toHaveCount(0);

    // Nothing is prevented on the field, so the page leaves the system its own right-click.
    const prevented = await field.evaluate((input) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(false);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("The text menu follows the app's language, English here", async () => {
  test.setTimeout(180_000);
  const { app, page, userData } = await start({ PYXIS_E2E_SYSTEM_LANGUAGES: "en-US" });
  try {
    const search = page.getByRole("textbox").first();
    expect(labelsOf(await textMenuOf(app, search))).toEqual(["Undo", "Redo", "-", "Cut", "Copy", "Paste", "-", "Select all"]);
    await addProbeFields(page);
    expect(labelsOf(await textMenuOf(app, page.locator("#probe-readonly")))).toEqual(["Copy", "Select all"]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
