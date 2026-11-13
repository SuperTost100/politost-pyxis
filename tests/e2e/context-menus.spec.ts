import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { answerNextMenu, lastMenuAt, lastMenuLabels } from "./native-menu";
import { seedPlan, seedSource, seedSubjects } from "./seed";

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

    // A Library file (here in "Da sistemare", since it has no subject): the dots open the menu under the button, a
    // right-click opens the same items at the pointer.
    await page.evaluate(() => {
      location.hash = "/exams/library";
    });
    const row = page.locator(".px-unsorted-row", { hasText: "Appunti di fisica" });
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

    // A platform can send a contextmenu for the menu key besides the key press: Chromium on Windows sends one when the key
    // is released unless the page handles the release, to the element that has focus then. The menu takes the focus a
    // frame after it opens, so that element is the name or the menu. The orders below are sent to the name before the
    // menu takes the focus, and to whatever has the focus a frame later. In each, the menu opens once under the name as
    // the keyboard's: Escape gives the focus back to the name, and a right-click moves the menu to the pointer.
    await name.focus();
    await page.keyboard.press("ContextMenu");
    expect(await itemsOf(page, "Azioni")).toEqual(fromDots);
    const keyMenu = (await page.getByRole("menu").boundingBox())!;
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    type Sent = "keydown" | "keyup" | "contextmenu";
    const send = (order: Sent[], to: "name" | "focused") =>
      name.evaluate(
        async (button, { order, to }) => {
          const prevented: string[] = [];
          for (const type of order) {
            const target = to === "name" ? button : document.activeElement!;
            const at = target.getBoundingClientRect();
            const event =
              type === "contextmenu"
                ? new MouseEvent(type, { bubbles: true, cancelable: true, clientX: at.left + at.width / 2, clientY: at.top + at.height / 2 })
                : new KeyboardEvent(type, { key: "ContextMenu", bubbles: true, cancelable: true });
            target.dispatchEvent(event);
            if (event.defaultPrevented) prevented.push(type);
            // The platform sends each event as a task of its own; "focused" lets the menu take the focus between them.
            await new Promise((resolve) => (to === "name" ? setTimeout(resolve, 0) : requestAnimationFrame(resolve)));
          }
          return prevented;
        },
        { order, to },
      );
    const orders: Sent[][] = [["keydown", "keyup", "contextmenu"], ["contextmenu", "keydown", "keyup"], ["contextmenu"]];
    for (const order of orders)
      for (const to of ["name", "focused"] as const) {
        const step = `${order.join(", ")} to the ${to}`;
        await name.focus();
        // Every event is handled, the key's release too, so Windows sends no contextmenu of its own.
        expect(await send(order, to), step).toEqual(order);
        await expect(page.getByRole("menu"), step).toHaveCount(1);
        await expect.poll(async () => page.getByRole("menu").boundingBox(), { message: step }).toEqual(keyMenu);
        expect(await itemsOf(page, "Azioni"), step).toEqual(fromDots);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu"), step).toHaveCount(0);
        await expect(name, step).toBeFocused();

        await send(order, to);
        await expect.poll(async () => page.getByRole("menu").boundingBox(), { message: step }).toEqual(keyMenu);
        const nameNow = (await name.boundingBox())!;
        const pointer = { x: nameNow.x + nameNow.width - 4, y: nameNow.y + nameNow.height / 2 };
        await page.mouse.click(pointer.x, pointer.y, { button: "right" });
        await expect
          .poll(async () => {
            const menuBox = (await page.getByRole("menu").boundingBox())!;
            return [Math.abs(menuBox.x - pointer.x) < 24, Math.abs(menuBox.y - pointer.y) < 24];
          }, { message: step })
          .toEqual([true, true]);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu"), step).toHaveCount(0);
      }

    // A right-click on the name's far end while the key's menu is open moves the menu to the pointer.
    await name.focus();
    await page.keyboard.press("ContextMenu");
    await expect(page.getByRole("menu")).toBeVisible();
    const nameAt = (await name.boundingBox())!;
    const far = { x: nameAt.x + nameAt.width - 4, y: nameAt.y + nameAt.height / 2 };
    expect(far.x - (nameAt.x + 8)).toBeGreaterThan(40);
    await page.mouse.click(far.x, far.y, { button: "right" });
    await expect
      .poll(async () => {
        const menuBox = (await page.getByRole("menu").boundingBox())!;
        return [Math.abs(menuBox.x - far.x) < 24, Math.abs(menuBox.y - far.y) < 24];
      })
      .toEqual([true, true]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

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

/**
 * The three dots that stand alone on a page, with no item around them: each opens its menu by a click, by a right-click
 * on the dots, and by the context-menu key and Shift+F10 on them, with the same items, and one Escape closes the menu
 * and gives the focus back to the dots.
 */
async function opensEveryWay(page: Page, dots: Locator, region: string, expected?: string[]) {
  const menu = page.getByRole("region", { name: region }).getByRole("menu");
  const itemsNow = async () => {
    await expect(menu).toBeVisible();
    return menu.getByRole("menuitem").allTextContents();
  };
  const ways: Array<[string, () => Promise<void>]> = [
    ["a click", () => dots.click()],
    ["a right-click", () => dots.click({ button: "right" })],
    ["the context-menu key", async () => {
      await dots.focus();
      await page.keyboard.press("ContextMenu");
    }],
    ["Shift+F10", async () => {
      await dots.focus();
      await page.keyboard.press("Shift+F10");
    }],
  ];
  let first: string[] | undefined = expected;
  for (const [how, open] of ways) {
    await open();
    const items = await itemsNow();
    first ??= items;
    expect(items, how).toEqual(first);
    // A pointer opens it at the pointer's place and the keys under the button, so it is never far from the dots.
    const box = (await dots.boundingBox())!;
    const at = (await menu.boundingBox())!;
    expect(Math.abs(at.y - (box.y + box.height)) < 60 || Math.abs(at.y - (box.y + box.height / 2)) < 60, how).toBe(true);
    await page.keyboard.press("Escape");
    await expect(menu, how).toBeHidden();
    await expect(dots, how).toBeFocused();
  }
  return first!;
}

test("an answer's, a lesson's and a map's three dots open by click, right-click and the menu keys, and Escape closes only the menu", async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-dots-alone-"));
  const reply = "Una funzione continua su un intervallo chiuso ha un massimo.";
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_REPLY: reply } });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 832 });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seedSubjects(db, [{ id: "cin", name: "Cinema" }]);
    seedSource(db, {
      id: "s-cin",
      title: "Manuale di cinema",
      subjectId: "cin",
      document: { id: "d-cin" },
      passages: [{ id: "pc-1", text: "Il montaggio lega le inquadrature.", section: "Montaggio" }],
    });
    seedPlan(db, { id: "p-les", title: "Fisica 1", topics: [{ id: "t-les", title: "Forze" }] });
    db.exec(`
      INSERT INTO chats(id,title,created_at,updated_at) VALUES('c1','Weierstrass',1,2);
      INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('m-q','c1','user','Che cosa dice il teorema?',1);
      INSERT INTO messages(id,chat_id,role,body,engine_provider,model_id,model_source,created_at)
        VALUES('m-a','c1','assistant','Dice che una funzione continua è limitata.','claude','claude-sonnet-5','reported',2);
    `);
    db.prepare(
      "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,grounding,created_at) VALUES('i-les','p-les','t-les','lesson',?,'fixture','sources',1)",
    ).run(
      JSON.stringify({
        cacheKey: JSON.stringify({ kind: "lesson", scopeId: "t-les", promptVersion: "model-1", passageIds: [] }),
        markdown: "## La dinamica\n\nLa seconda legge di Newton è $F=ma$.",
      }),
    );
    const node = (id: string, label: string, parent: string | null, sources?: string[]) => ({
      id,
      label,
      parent,
      x: 0,
      y: 0,
      pinned: false,
      ...(sources ? { sources } : {}),
    });
    db.prepare("INSERT INTO maps(id,subject_id,graph_json,grounding,created_at) VALUES('row-cin','cin',?,'sources',1)").run(
      JSON.stringify({
        version: 1,
        maps: [
          {
            id: "m-cin",
            title: "Il montaggio",
            passageIds: [],
            grounding: "sources",
            graph: {
              layout: "tree",
              undo: null,
              redo: null,
              nodes: [node("n0", "Montaggio", null, ["pc-1"]), node("n1", "Taglio", "n0"), node("n2", "Dissolvenza", "n0")],
              edges: [
                { from: "n0", to: "n1" },
                { from: "n0", to: "n2" },
              ],
            },
          },
        ],
      }),
    );
    db.close();

    // An answer: the menu under it has one item, which asks again with the strongest model.
    await page.evaluate(() => {
      location.hash = "/ask/c1";
    });
    await page.reload();
    const answer = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(answer).toContainText("Dice che una funzione continua è limitata.");
    // The right-click on the answer's own text is still the system's: nothing is prevented, no menu opens.
    const onText = await answer.locator(".px-msg-text").evaluate((text) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      text.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(onText).toBe(false);
    await expect(page.getByRole("menu")).toHaveCount(0);
    const answerDots = answer.getByRole("button", { name: "Altre azioni" });
    const stronger = "Rispondi di nuovo con il modello più potente";
    expect(await opensEveryWay(page, answerDots, "Altre azioni", [stronger])).toEqual([stronger]);
    await answerDots.click({ button: "right" });
    await page.getByRole("menuitem", { name: stronger }).click();
    await expect(page.locator(".px-msg:not(.px-msg-user) .px-msg-text")).toHaveText(reply, { timeout: 30_000 });

    // A lesson: regenerate, rewrite a part, the map and export; the last one opens the export dialog.
    await page.evaluate(() => {
      location.hash = "/plans/p-les/lesson/t-les";
    });
    await expect(page.getByText("La seconda legge di Newton", { exact: false })).toBeVisible();
    const lessonDots = page.getByRole("button", { name: "Altre azioni" });
    const lessonItems = await opensEveryWay(page, lessonDots, "Altre azioni");
    expect(lessonItems).toEqual(["Riscrivi", "Riscrivi una parte", "Mappa", "Esporta"]);
    await lessonDots.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Esporta" }).click();
    const exportDialog = page.getByRole("dialog", { name: "Esporta" });
    await expect(exportDialog.getByRole("button", { name: "Salva file" })).toBeVisible();
    await exportDialog.getByRole("button", { name: "Annulla" }).click();
    await expect(exportDialog).toBeHidden();

    // A map: rename, export (with its formats) and delete; the last one asks first.
    await page.evaluate(() => {
      location.hash = "/maps/cin?from=maps&map=m-cin";
    });
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    const mapDots = page.locator(".px-map-actions").getByRole("button", { name: "Altro", exact: true });
    expect(await opensEveryWay(page, mapDots, "Altro")).toEqual(["Rinomina", "Esporta", "Elimina la mappa…"]);
    // With the concept's source open beside the map, an Escape for the menu leaves the panel, and the next one closes it.
    await page.locator('.react-flow__node[data-id="n0"]').click();
    const sourceButton = page.locator(".px-map-foot").getByRole("button", { name: "Manuale di cinema", exact: true });
    await sourceButton.click();
    const panel = page.getByRole("complementary", { name: /Manuale di cinema/ });
    await expect(panel.locator(".source-viewer-paragraph.is-current")).toBeVisible();
    await opensEveryWay(page, mapDots, "Altro");
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await mapDots.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Elimina la mappa…" }).click();
    const confirm = page.getByRole("dialog");
    await expect(confirm.getByRole("button", { name: "Elimina la mappa" })).toBeVisible();
    await confirm.getByRole("button", { name: "Annulla" }).click();
    await expect(confirm).toBeHidden();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
