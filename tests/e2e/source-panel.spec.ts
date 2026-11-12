import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams, toLibrary } from "./doors";
import { animationsSettled } from "./settled";
import { BOOK_PAGES, CITED_PAGE, LONG_TITLE, seedSourcePanel } from "./source-panel-fixture";

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
  db.close();
  return { app, page, userData, bookBytes };
}

const panel = (page: Page) => page.locator("aside.source-panel");
const openedFiles = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { pyxisE2eOpenedFiles: () => Array<{ sourceId: string; name: string; stored: boolean }> }).pyxisE2eOpenedFiles());

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
    // The page behind stays usable beside the panel: the second citation moves the panel, it does not stack.
    const second = reply.locator(".px-cite").nth(1);
    await second.click();
    await expect(sheet).toHaveCount(1);
    await expect(sheet.getByRole("heading", { name: "Appunti, lezioni 1-9" })).toBeVisible();
    await expect(sheet.locator(".source-viewer-paragraph.is-current")).toContainText("Un integrale doppio");
    // The close button closes it, and focus goes back to the chip that opened it.
    await sheet.getByRole("button", { name: "Chiudi" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(second).toBeFocused();
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
