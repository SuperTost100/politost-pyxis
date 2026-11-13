import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams, toLibrary } from "./doors";
import { animationsSettled } from "./settled";
import { BOOK_PAGES, CITED_PAGE, FIGURE_BYTES, LONG_TITLE, seedPanelReads, seedSourcePanel } from "./source-panel-fixture";

async function launch() {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-source-panel-"));
  const app = await launchPyxis({ userData });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  const { bookBytes } = seedSourcePanel(db, userData);
  const { linkedPath } = seedPanelReads(db, userData);
  db.close();
  return { app, page, userData, bookBytes, linkedPath };
}

const panel = (page: Page) => page.locator("aside.source-panel");
const openedFiles = (app: ElectronApplication) =>
  app.evaluate(() =>
    (
      globalThis as unknown as { pyxisE2eOpenedFiles: () => Array<{ sourceId: string; name: string; stored: boolean; path: string }> }
    ).pyxisE2eOpenedFiles(),
  );

test("the Library opens each file in the source panel, at its first page, and pages by mouse, keyboard and number", async () => {
  test.setTimeout(240_000);
  const { app, page, userData, bookBytes } = await launch();
  try {
    await toLibrary(page);
    const cover = page.getByRole("button", { name: "Fisica I · Mazzoldi, Nigro, Voci", exact: true });
    await cover.click();
    const sheet = panel(page);
    await expect(sheet).toHaveCount(1);
    await expect(page.getByRole("complementary", { name: "Fisica I · Mazzoldi, Nigro, Voci" })).toBeVisible();
    // Focus goes into the panel, onto its name.
    await expect(sheet.getByRole("heading", { name: "Fisica I · Mazzoldi, Nigro, Voci" })).toBeFocused();
    const pageGroup = sheet.getByRole("group", { name: `Pagina 1 di ${BOOK_PAGES}` });
    await expect(pageGroup).toBeVisible();
    await expect(sheet.locator(".source-pdf-page canvas")).toBeVisible();
    // The first page: no way back, a way on.
    const previous = sheet.getByRole("button", { name: "Pagina precedente" });
    const next = sheet.getByRole("button", { name: "Pagina successiva" });
    await expect(previous).toBeDisabled();
    await next.click();
    await expect(sheet.getByRole("group", { name: `Pagina 2 di ${BOOK_PAGES}` })).toBeVisible();
    // The keyboard pages while the panel has the focus, and each page is announced.
    await sheet.locator(".source-view-page").focus();
    await page.keyboard.press("ArrowRight");
    await expect(sheet.getByRole("group", { name: `Pagina 3 di ${BOOK_PAGES}` })).toBeVisible();
    await expect(sheet.locator("[aria-live=polite]")).toHaveText(`Pagina 3 di ${BOOK_PAGES}`);
    await page.keyboard.press("PageUp");
    await expect(sheet.getByRole("group", { name: `Pagina 2 di ${BOOK_PAGES}` })).toBeVisible();
    // A page typed over the number, then the last one, where the way on stops.
    const field = sheet.getByRole("textbox", { name: "Vai alla pagina" });
    await field.fill(String(CITED_PAGE));
    await field.press("Enter");
    await expect(sheet.getByRole("group", { name: `Pagina ${CITED_PAGE} di ${BOOK_PAGES}` })).toBeVisible();
    await expect(sheet.locator(".source-pdf-text")).toContainText(`Questa e la pagina ${CITED_PAGE}`);
    await field.fill("99999");
    await field.press("Enter");
    await expect(sheet.getByRole("group", { name: `Pagina ${BOOK_PAGES} di ${BOOK_PAGES}` })).toBeVisible();
    await expect(next).toBeDisabled();
    // Six pages drawn out of 900, and a small part of the 36 MB file read for them.
    const read = Number(await sheet.locator(".source-pdf").getAttribute("data-bytes-read"));
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(bookBytes / 20);

    // "Apri il file" asks main for this file by its id; main hands a named copy of the stored original to the system.
    await sheet.getByRole("button", { name: "Apri il file" }).click();
    await expect.poll(() => openedFiles(app)).toEqual([
      expect.objectContaining({ sourceId: "sp-book", name: "Fisica I · Mazzoldi, Nigro, Voci.pdf", stored: true }),
    ]);
    // A path the window makes up opens nothing.
    expect(await page.evaluate(() => window.pyxis.openSourceFile("../../etc/passwd"))).toBe(false);
    await expectNoAxeViolations(page);

    // Escape closes it, and focus goes back to the cover.
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(cover).toBeFocused();

    // A scan: the picture, with the text read from it.
    await page.getByRole("button", { name: "Tema d'esame, febbraio 2025", exact: true }).click();
    await expect(sheet.getByRole("group", { name: "Pagina 1 di 1" })).toBeVisible();
    await sheet.getByText("Testo letto da questa pagina").click();
    await expect(sheet.getByText("Esercizio 1. Calcola la velocità media")).toBeVisible();
    // Closed and opened again at once, on another cover: the exit of the first panel does not close the second.
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Tema d'esame, febbraio 2025", exact: true }).click();
    await page.waitForTimeout(400);
    await expect(sheet).toHaveCount(1);
    // A photo, from a second cover: the panel moves to it instead of opening another.
    await page.getByRole("button", { name: "Lavagna, lezione 10", exact: true }).click();
    await expect(sheet).toHaveCount(1);
    await expect(sheet.getByRole("img", { name: "Lavagna, lezione 10" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Pagina successiva" })).toHaveCount(0);
    // Word notes: the text Pyxis read, said to be only that, and the file one click away.
    await page.getByRole("button", { name: "Appunti, lezioni 1-9", exact: true }).click();
    await expect(sheet.getByText(/Impaginazione e figure le trovi aprendolo nel suo programma/)).toBeVisible();
    await expect(sheet.getByText(/Un integrale doppio si calcola per fili/)).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Apri il file" })).toBeVisible();
    // A saved web page: its address and the way to it, no file to open.
    await page.getByRole("button", { name: "Serie di Fourier", exact: true }).click();
    await expect(sheet.getByText("https://appunti.example.org/fourier")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Apri la pagina web" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Apri il file" })).toHaveCount(0);
    // A linked file that was moved away: the panel says so and how to fix it.
    await page.getByRole("button", { name: "Appunti lezione 5", exact: true }).click();
    await expect(sheet.getByRole("heading", { name: "Non trovo più questo file" })).toBeVisible();
    await expect(sheet.getByText(/Rimettilo dov'era/)).toBeVisible();
    // A very long name stays on one line in the head, cut with an ellipsis, and the close button stays in the panel.
    await page.getByRole("button", { name: LONG_TITLE, exact: true }).click();
    const title = sheet.getByRole("heading", { name: LONG_TITLE });
    await expect(title).toBeVisible();
    const [titleBox, sheetBox, closeBox] = await Promise.all([
      title.boundingBox(),
      sheet.boundingBox(),
      sheet.getByRole("button", { name: "Chiudi" }).boundingBox(),
    ]);
    expect(titleBox!.height).toBeLessThan(30);
    expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(sheetBox!.x + sheetBox!.width);

    // The file's menu is in the panel's head, the same as the cover's: Dettagli puts the details in the panel's place.
    await sheet.getByRole("button", { name: `Azioni su «${LONG_TITLE}»` }).click();
    await page.getByRole("menuitem", { name: "Dettagli della fonte" }).click();
    await expect(page.getByRole("dialog", { name: LONG_TITLE })).toBeVisible();
    await expect(sheet).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("one Escape closes the panel's menu and leaves the panel open, whichever way the menu was opened", async () => {
  test.setTimeout(240_000);
  const { app, page, userData } = await launch();
  try {
    await toLibrary(page);
    const cover = page.getByRole("button", { name: "Fisica I · Mazzoldi, Nigro, Voci", exact: true });
    await cover.click();
    const sheet = panel(page);
    const title = sheet.getByRole("heading", { name: "Fisica I · Mazzoldi, Nigro, Voci" });
    await expect(title).toBeFocused();
    const dots = sheet.getByRole("button", { name: "Azioni su «Fisica I · Mazzoldi, Nigro, Voci»" });
    const menu = page.getByRole("menu").filter({ has: page.getByRole("menuitem", { name: "Dettagli della fonte" }) });
    const opened: Array<[string, () => Promise<void>]> = [
      ["a click on the dots", () => dots.click()],
      ["a right-click on the dots", () => dots.click({ button: "right" })],
      ["a right-click on the name", () => title.click({ button: "right" })],
      ["Shift+F10 on the name", async () => {
        await title.focus();
        await page.keyboard.press("Shift+F10");
      }],
      ["Shift+F10 on the dots", async () => {
        await dots.focus();
        await page.keyboard.press("Shift+F10");
      }],
    ];
    for (const [how, open] of opened) {
      await animationsSettled(page);
      await open();
      await expect(menu, how).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu, how).toHaveCount(0);
      await expect(sheet, how).toHaveCount(1);
      await expect(sheet, how).not.toHaveClass(/is-leaving/);
    }
    // With the menu gone, the next Escape closes the panel.
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("with animations on, a second Escape closes the panel while the menu is still fading out", async () => {
  test.setTimeout(240_000);
  const { app, page, userData } = await launch();
  try {
    await toLibrary(page);
    await page.getByRole("button", { name: "Fisica I · Mazzoldi, Nigro, Voci", exact: true }).click();
    const sheet = panel(page);
    await expect(sheet).toHaveCount(1);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const dots = sheet.getByRole("button", { name: "Azioni su «Fisica I · Mazzoldi, Nigro, Voci»" });
    const menu = page.getByRole("menu").filter({ has: page.getByRole("menuitem", { name: "Dettagli della fonte" }) });
    for (const [how, open] of [
      ["a click", () => dots.click()],
      ["a right-click", () => dots.click({ button: "right" })],
    ] as const) {
      await animationsSettled(page);
      await open();
      await expect(menu, how).toBeVisible();
      // One Escape closes the menu only.
      await page.keyboard.press("Escape");
      await expect(sheet, how).toHaveCount(1);
      await expect(sheet, how).not.toHaveClass(/is-leaving/);
      await animationsSettled(page);
      await open();
      await expect(menu, how).toBeVisible();
      // Two in a row, with no wait between them: the first closes the menu, the second the panel.
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(sheet, how).toHaveCount(0);
      await page.getByRole("button", { name: "Fisica I · Mazzoldi, Nigro, Voci", exact: true }).click();
      await expect(sheet).toHaveCount(1);
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a menu that is open when its file goes away closes, whichever way it was opened", async () => {
  test.setTimeout(240_000);
  const title = "Lavagna, lezione 10";
  const ways: Array<[string, (page: Page) => Promise<void>]> = [
    ["a click on the dots", (page) => panel(page).getByRole("button", { name: `Azioni su «${title}»` }).click()],
    ["a right-click on the dots", (page) => panel(page).getByRole("button", { name: `Azioni su «${title}»` }).click({ button: "right" })],
    ["Shift+F10 on the name", async (page) => {
      await panel(page).getByRole("heading", { name: title }).focus();
      await page.keyboard.press("Shift+F10");
    }],
  ];
  // Each way starts from a fresh app, since each ends with the file removed.
  for (const [how, open] of ways) {
    const { app, page, userData } = await launch();
    try {
      await toLibrary(page);
      const sheet = panel(page);
      const menu = page.getByRole("menu").filter({ has: page.getByRole("menuitem", { name: "Dettagli della fonte" }) });
      const id = await page.evaluate(
        async (title) => ((await window.pyxis.invoke("sources.list", {})) as Array<{ id: string; title: string }>).find((row) => row.title === title)!.id,
        title,
      );
      await page.getByRole("button", { name: title, exact: true }).click();
      await expect(sheet, how).toHaveCount(1);
      await expect(sheet.getByRole("heading", { name: title }), how).toBeFocused();
      await open(page);
      await expect(menu, how).toBeVisible();
      // The file is removed from outside the page, so there is no menu to offer for it: the open one goes too.
      await page.evaluate((sourceId) => window.pyxis.invoke("sources.remove", { sourceId, confirmed: true }), id);
      // A file added afterwards makes the page read the library again, as a finished import does.
      await page.evaluate(
        (how) =>
          window.pyxis.invoke("sources.paste", {
            title: `Arrivo ${how}`,
            text: "La probabilità condizionata di A dato B è il rapporto tra P(A e B) e P(B).\n\n".repeat(20),
          }),
        how,
      );
      await expect(menu, how).toHaveCount(0);
      // With no menu open, the next Escape is the panel's.
      await page.keyboard.press("Escape");
      await expect(sheet, how).toHaveCount(0);
    } finally {
      await app.close();
      removeTestFolder(userData);
    }
  }
});

test("a citation in a chat opens the panel at the cited page with the passage marked, and a second one moves it", async () => {
  test.setTimeout(240_000);
  const { app, page, userData } = await launch();
  try {
    await page.evaluate(() => {
      location.hash = "/ask/sp-chat";
    });
    const reply = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(reply.locator(".px-cite")).toHaveCount(2);
    const first = reply.locator(".px-cite").first();
    await first.click();
    const sheet = panel(page);
    await expect(sheet.getByRole("group", { name: `Pagina ${CITED_PAGE} di ${BOOK_PAGES}` })).toBeVisible();
    // The passage is marked by a line in the page's margin, beside its lines, with no colour behind its words.
    const mark = sheet.locator(".source-cite-mark");
    await expect(mark).toBeVisible();
    const lines = await sheet.locator(".source-pdf-text .is-cited").evaluateAll((spans) =>
      spans.map((span) => span.getBoundingClientRect()).map((box) => ({ top: box.top, bottom: box.bottom, left: box.left })),
    );
    const markBox = (await mark.boundingBox())!;
    expect(markBox.y).toBeLessThanOrEqual(Math.min(...lines.map((line) => line.top)) + 1);
    expect(markBox.y + markBox.height).toBeGreaterThanOrEqual(Math.max(...lines.map((line) => line.bottom)) - 1);
    expect(markBox.x + markBox.width).toBeLessThan(Math.min(...lines.map((line) => line.left)));
    await expect(sheet.locator(".source-pdf-text .is-cited")).toHaveCount(3);
    expect(
      await sheet.locator(".source-pdf-text .is-cited").first().evaluate((span) => getComputedStyle(span).backgroundColor),
    ).toBe("rgba(0, 0, 0, 0)");
    // The cited passage is there as text for a screen reader.
    await expect(sheet.getByText(/Brano citato in questa pagina: Il percorso inverso/)).toBeAttached();
    // The page behind stays usable: the second citation moves the panel, it does not stack. Below 1180 pixels the panel
    // lies over the page's right side (a Windows runner's window is 1024 wide) and can cover the citation, which the
    // keyboard still reaches, so the citation is opened from the keyboard.
    const second = reply.locator(".px-cite").nth(1);
    await second.focus();
    await page.keyboard.press("Enter");
    await expect(sheet).toHaveCount(1);
    await expect(sheet.getByRole("heading", { name: "Appunti, lezioni 1-9" })).toBeVisible();
    await expect(sheet.locator(".source-viewer-paragraph.is-current")).toContainText("Un integrale doppio");
    // The close button closes it, and focus goes back to the chip that opened it.
    await sheet.getByRole("button", { name: "Chiudi" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(second).toBeFocused();
    // The list of what the answer used opens the same panel, at the same place.
    await page.locator(".ask-used-line").last().click();
    const used = page.locator(".ask-used-item").first();
    await used.click();
    await expect(sheet).toHaveCount(1);
    await expect(sheet.getByRole("group", { name: `Pagina ${CITED_PAGE} di ${BOOK_PAGES}` })).toBeVisible();
    await expect(sheet.locator(".source-cite-mark")).toBeVisible();
    await sheet.getByRole("button", { name: "Chiudi" }).click();
    await expect(used).toBeFocused();
    // A citation to a page the file no longer has: the last page, a line that says so, and the cited words.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("pyxis:source-viewer", { detail: { passageId: "sp-book-gone" } })));
    await expect(sheet.getByText(`Il file non ha più la pagina ${BOOK_PAGES + 40}: ora ne ha ${BOOK_PAGES}. Ti mostro l'ultima.`)).toBeVisible();
    await expect(sheet.getByRole("group", { name: `Pagina ${BOOK_PAGES} di ${BOOK_PAGES}` })).toBeVisible();
    await expect(sheet.getByRole("region", { name: "Brano citato" })).toContainText("Appendice B. Tavole delle costanti fisiche.");
    await sheet.getByRole("button", { name: "Chiudi" }).click();
    // Leaving the page closes it: it belongs to the page that opened it.
    await first.click();
    await expect(sheet).toHaveCount(1);
    await page.getByRole("navigation", { name: "Sezioni" }).getByRole("link", { name: "Libreria" }).click();
    await expect(sheet).toHaveCount(0);
    await animationsSettled(page);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a picture larger than one read draws, and a linked file moved while its page is open says so", async () => {
  test.setTimeout(240_000);
  const { app, page, userData, linkedPath } = await launch();
  try {
    await toLibrary(page);
    const sheet = panel(page);
    // The picture's stream is longer than core returns in one call: the page draws once all of it has come.
    await page.getByRole("button", { name: "Figura grande", exact: true }).click();
    const figure = sheet.getByRole("group", { name: "Pagina 1 di 1" });
    await expect(figure).toHaveAttribute("aria-busy", "false");
    await expect(sheet.locator(".source-pdf-text")).toContainText("Una figura che pesa piu di due mega.");
    expect(Number(await sheet.locator(".source-pdf").getAttribute("data-bytes-read"))).toBeGreaterThan(FIGURE_BYTES);
    await expect(sheet.locator(".source-page-working")).toHaveCount(0);

    // A linked file, open at its first page, then moved out of its folder (a move inside it is followed). Its cover can
    // lie under the open panel in a narrow window, so it is opened from the keyboard.
    await page.getByRole("button", { name: "Esercizi svolti", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(sheet.getByRole("group", { name: "Pagina 1 di 40" })).toHaveAttribute("aria-busy", "false");
    renameSync(linkedPath, join(userData, "Esercizi svolti.pdf"));
    // Page 20 lies in the middle of the file, in bytes not read yet (the last pages sit next to the cross-reference
    // table pdf.js reads first). The read fails, and the panel says where the file went instead of waiting.
    const field = sheet.getByRole("textbox", { name: "Vai alla pagina" });
    await field.fill("20");
    await field.press("Enter");
    await expect(sheet.getByRole("heading", { name: "Non trovo più questo file" })).toBeVisible();
    await expect(sheet.getByText(/Rimettilo dov'era/)).toBeVisible();
    await expect(sheet.locator(".source-page-working")).toHaveCount(0);
    await expect(sheet.locator(".source-pdf")).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("Apri il file keeps its copy in Pyxis's own folder, and a removed source or a wipe leaves none of it", async () => {
  test.setTimeout(240_000);
  const { app, page, userData } = await launch();
  const copies = join(userData, "open-copies");
  const left = () => (existsSync(copies) ? readdirSync(copies) : []);
  try {
    await toLibrary(page);
    const sheet = panel(page);
    const openThrough = async (title: string, sourceId: string) => {
      await page.getByRole("button", { name: title, exact: true }).click();
      await sheet.getByRole("button", { name: "Apri il file" }).click();
      await expect.poll(async () => (await openedFiles(app)).filter((file) => file.sourceId === sourceId)).toHaveLength(1);
      const opened = (await openedFiles(app)).find((file) => file.sourceId === sourceId)!;
      return opened.path;
    };
    const book = await openThrough("Fisica I · Mazzoldi, Nigro, Voci", "sp-book");
    const photo = await openThrough("Lavagna, lezione 10", "sp-photo");
    // Each copy has the file's name, in the app's own folder, and nowhere in the system's temporary folder.
    for (const [path, name] of [
      [book, "Fisica I · Mazzoldi, Nigro, Voci.pdf"],
      [photo, "Lavagna, lezione 10.png"],
    ] as const) {
      expect(relative(copies, path).startsWith("..")).toBe(false);
      expect(path.endsWith(name)).toBe(true);
      expect(existsSync(path)).toBe(true);
    }
    expect(left().sort()).toEqual(["sp-book", "sp-photo"]);

    // Removed from the Library: its copy goes, the other stays.
    expect(await page.evaluate(() => window.pyxis.invoke("sources.remove", { sourceId: "sp-photo", confirmed: true }))).toMatchObject({
      removed: true,
    });
    await expect.poll(() => existsSync(photo)).toBe(false);
    // Main removes the copy's folder, with the file in it, and then the source's folder, so the list is polled as well.
    await expect.poll(left).toEqual(["sp-book"]);
    expect(existsSync(book)).toBe(true);

    // "Elimina tutto": nothing of an opened file stays behind.
    expect(await page.evaluate(() => window.pyxis.wipeWorkspace({ backups: false }))).toBe("wiped");
    expect(existsSync(book)).toBe(false);
    expect(left()).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
