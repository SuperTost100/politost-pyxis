import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { answerNextMenu, lastMenuAt, lastMenuLabels } from "./native-menu";
import { seedSource } from "./seed";

/** The labels of the open menu, a separator left out. */
const itemsOf = async (page: Page, region: string) => {
  const menu = page.getByRole("region", { name: region }).getByRole("menu");
  await expect(menu).toBeVisible();
  return menu.getByRole("menuitem").allTextContents();
};

test("a right-click opens the same menu as the three dots, at the pointer, and so do the menu keys", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-context-menus-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 832 });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seedSource(db, {
      id: "s1",
      title: "Appunti di fisica",
      document: { id: "d1" },
      passages: [{ id: "p1", text: "Il calore si trasmette per conduzione.", locator: {}, section: "2. Termodinamica" }],
    });
    db.exec(`
      INSERT INTO chats(id,title,created_at,updated_at) VALUES('c-termo','Termodinamica',1,2),('c-analisi','Analisi',1,1);
      INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('m1','c-termo','user','Perché il calore passa?',1);
    `);
    db.close();

    // A Library row: the dots open the menu under the button, a right-click opens the same items at the pointer.
    await page.evaluate(() => {
      location.hash = "/exams/library";
    });
    const row = page.locator(".px-source-row", { hasText: "Appunti di fisica" });
    await expect(row).toBeVisible();
    const dots = row.getByRole("button", { name: "Azioni per Appunti di fisica" });
    await dots.click();
    const fromDots = await itemsOf(page, "Azioni");
    expect(fromDots.length).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    const box = (await row.boundingBox())!;
    const point = { x: box.x + 120, y: box.y + box.height / 2 };
    await page.mouse.click(point.x, point.y, { button: "right" });
    expect(await itemsOf(page, "Azioni")).toEqual(fromDots);
    // It hangs from the pointer: its corner is where the click was, not under the dots at the row's end.
    await expect
      .poll(async () => {
        const menuBox = (await page.getByRole("menu").boundingBox())!;
        return [Math.abs(menuBox.x - point.x) < 24, Math.abs(menuBox.y - point.y) < 24];
      })
      .toEqual([true, true]);
    // A click away closes it, and a pick acts like the dots' pick would.
    await page.mouse.click(5, 400);
    await expect(page.getByRole("menu")).toHaveCount(0);

    // The keyboard: the context-menu key and Shift+F10 on the row's name open it under that name, Escape closes it and
    // focus goes back there.
    const name = row.getByRole("button", { name: "Appunti di fisica", exact: true });
    for (const key of ["ContextMenu", "Shift+F10"]) {
      await name.focus();
      await page.keyboard.press(key);
      expect(await itemsOf(page, "Azioni"), key).toEqual(fromDots);
      const nameBox = (await name.boundingBox())!;
      await expect
        .poll(async () => Math.abs((await page.getByRole("menu").boundingBox())!.y - (nameBox.y + nameBox.height)) < 24, { message: key })
        .toBe(true);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(name, key).toBeFocused();
    }

    // The search field of the page keeps the system's own menu: nothing opens, and nothing is prevented.
    const field = page.getByRole("textbox").first();
    const prevented = await field.evaluate((input) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(false);
    await expect(page.getByRole("menu")).toHaveCount(0);

    // The profile button at the foot of the sidebar opens its menu on a right-click too, and Escape closes it.
    const profile = page.locator(".px-side-me");
    await profile.click({ button: "right" });
    await expect(page.getByRole("menu", { name: "Il tuo profilo" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu", { name: "Il tuo profilo" })).toHaveCount(0);
    await expect(profile).toBeFocused();

    // A chat in the sidebar: its menu is the system's, so the test reads the labels main was asked to show.
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    const chats = page.getByRole("list", { name: "Chat" });
    await expect(chats.getByRole("listitem")).toHaveCount(2);
    await answerNextMenu(app, null);
    await chats.getByRole("button", { name: "Azioni per Termodinamica" }).click();
    const chatDots = await lastMenuLabels(app);
    expect(chatDots).toEqual(["Rinomina", "Esporta come Markdown", "Esporta come PDF", "-", "Elimina"]);
    expect(await lastMenuAt(app)).toBeUndefined();

    await answerNextMenu(app, null);
    await chats.getByRole("link", { name: /Termodinamica/ }).click({ button: "right" });
    await expect.poll(() => lastMenuLabels(app)).toEqual(chatDots);
    // A right-click pops the menu up at the pointer, which main knows without being told.
    expect(await lastMenuAt(app)).toBeUndefined();

    // The menu keys on the focused chat ask for the menu under it.
    const link = chats.getByRole("link", { name: /Analisi/ });
    for (const key of ["ContextMenu", "Shift+F10"]) {
      await answerNextMenu(app, null);
      await link.focus();
      await page.keyboard.press(key);
      await expect.poll(() => lastMenuLabels(app), key).toEqual(chatDots);
      const asked = (await lastMenuAt(app))!;
      const linkBox = (await link.boundingBox())!;
      expect(asked, key).toBeDefined();
      expect(Math.abs(asked.y - (linkBox.y + linkBox.height)), key).toBeLessThan(4);
      expect(Math.abs(asked.x - linkBox.x), key).toBeLessThan(16);
    }

    // The chat search: its rows answer a right-click, and the menu key on the field opens the active row's menu.
    await page.getByRole("button", { name: "Tutte le chat" }).click();
    const finder = page.getByRole("dialog", { name: "Cerca" });
    await expect(finder.getByRole("option")).toHaveCount(2);
    await answerNextMenu(app, null);
    await finder.getByRole("option", { name: /Analisi/ }).click({ button: "right" });
    await expect.poll(() => lastMenuLabels(app)).toEqual(chatDots);
    // The menu keys stay with the search field, whose own menu (copy, paste, spelling) they open: the chat's menu does
    // not take them, and nothing is prevented.
    const search = finder.getByRole("combobox", { name: "Cerca" });
    await answerNextMenu(app, null);
    for (const keys of [{ key: "ContextMenu" }, { key: "F10", shiftKey: true }]) {
      const prevented = await search.evaluate((input, init) => {
        const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        return event.defaultPrevented;
      }, keys);
      expect(prevented, keys.key).toBe(false);
      expect(await lastMenuLabels(app), keys.key).toBeUndefined();
    }
    // The chat's menu has its own key there, Alt+Enter (Option+Enter on a Mac), which opens the row Enter would open.
    await search.press("Alt+Enter");
    await expect.poll(() => lastMenuLabels(app)).toEqual(chatDots);
    const optionBox = (await finder.getByRole("option", { selected: true }).boundingBox())!;
    const askedFor = (await lastMenuAt(app))!;
    expect(askedFor).toBeDefined();
    expect(Math.abs(askedFor.y - (optionBox.y + optionBox.height))).toBeLessThan(4);
    // The search is still open: Alt+Enter did not open the chat.
    await expect(finder).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
