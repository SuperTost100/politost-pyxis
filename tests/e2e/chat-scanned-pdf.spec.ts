import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis, setUp } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { clickSettled } from "./settled";
import { saveShot } from "./shots";
import { drawScanPages, installTessdata, SCAN_PAGES, stagedTessdata, writeScanPdf } from "./scanned-pdf-fixture";

/*
 * A scanned PDF attached to a chat is read page by page when it is attached, by the Library's own scan job with the pinned
 * OCR files, and the chip shows the page it has reached. The question then lists the file, and its pages are in the chat's
 * scope. No model is called: the reply is a recorded one.
 */

const PAGE_COUNT = 20;
const staged = stagedTessdata();

test.skip(
  !staged,
  "the pinned tessdata (.tmp/tessdata-fast, hash-checked) is not on this machine and no test downloads it",
);

test("a scanned PDF is read page by page on its chip, then sent, and the chat holds its text", async () => {
  test.setTimeout(300000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-scan-"));
  // The language files are there, and the student agreed to local reading, as after an earlier download.
  installTessdata(userData, staged!);
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_REPLY: "La scansione dice che la forza è massa per accelerazione [P1]." } });
  try {
    await setUp(app, userData, async () => {
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "Salta" }).click();
      await fromChiediToExams(page);
      return page;
    });
    const page = await app.firstWindow();
    await page.evaluate(() => window.pyxis.setAppearance("light"));
    await page.evaluate(() => window.pyxis.invoke("sources.ocrData", { consent: true }));
    const drawn = await drawScanPages(page);
    const pdf = join(userData, "scansione.pdf");
    writeScanPdf(pdf, Array.from({ length: PAGE_COUNT }, (_, index) => drawn[index % drawn.length]!));
    await app.evaluate((_electron, selected) => {
      process.env["PYXIS_E2E_FILE"] = selected;
    }, pdf);
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.getByRole("button", { name: "Aggiungi un file o una formula" }).click();
    await clickSettled(page, page.getByRole("menuitem", { name: "Allega file o immagine" }));

    const chip = page.locator(".ask-attachments li").filter({ hasText: "scansione.pdf" });
    // The scan is not refused: its chip says which page is being read, and no banner appears.
    await expect(chip).toContainText(/Leggo la scansione, pagina \d+ di 20/, { timeout: 120000 });
    // The reading has a bar along the chip's lower edge, and Invia says what it waits for and goes quiet.
    await expect(chip.locator(".px-att-bar")).toBeVisible();
    await expect(page.getByText("Leggo 1 file…")).toBeVisible();
    const send = page.locator(".px-composer-bar").getByRole("button", { name: "Invia", exact: true });
    await expect(send).toHaveClass(/px-btn-secondary/);
    await saveShot(page, "chat-attachments/1-scanned-pdf-is-read-page-by-page.png");
    await expect(page.getByRole("alert")).toHaveCount(0);
    // The Library's jobs list does not show it: the chip is where the reading is.
    expect(await page.evaluate(() => window.pyxis.invoke("jobs.list", {}))).toEqual([]);
    await expect(chip).not.toContainText("Leggo", { timeout: 240000 });
    await expect(page.getByText("Leggo 1 file…")).toHaveCount(0);
    await expect(send).toHaveClass(/px-btn-primary/);

    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { readOnly: true, timeout: 10000 });
    try {
      const text = (db.prepare("SELECT text FROM passages").all() as Array<{ text: string }>).map((row) => row.text.toUpperCase()).join(" ");
      for (const [, word] of SCAN_PAGES) expect(text).toContain(word);
      expect(db.prepare("SELECT status, library FROM sources").all()).toEqual([{ status: "ready", library: 0 }]);
    } finally {
      db.close();
    }

    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Cosa dice la scansione?");
    await box.press("Enter");
    await expect(page.locator(".ask-sent-files").getByRole("button", { name: "scansione.pdf" })).toBeVisible();
    await expect(page.getByText("La scansione dice che la forza è massa per accelerazione")).toBeVisible();
    await expect(page.getByText("Ho usato il file che hai allegato")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a scan waits for its OCR data and says so on its chip, with the card that downloads it", async () => {
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-scan-nodata-"));
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_REPLY: "Ecco la risposta." } });
  try {
    await setUp(app, userData, async () => {
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "Salta" }).click();
      await fromChiediToExams(page);
      return page;
    });
    const page = await app.firstWindow();
    const drawn = await drawScanPages(page);
    const pdf = join(userData, "scansione.pdf");
    writeScanPdf(pdf, Array.from({ length: 3 }, (_, index) => drawn[index % drawn.length]!));
    await app.evaluate((_electron, selected) => {
      process.env["PYXIS_E2E_FILE"] = selected;
    }, pdf);
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.getByRole("button", { name: "Aggiungi un file o una formula" }).click();
    await clickSettled(page, page.getByRole("menuitem", { name: "Allega file o immagine" }));
    const chip = page.locator(".ask-attachments li").filter({ hasText: "scansione.pdf" });
    await expect(chip).toContainText("Per leggere questa scansione devo scaricare i dati per riconoscere il testo.", { timeout: 60000 });
    await expect(page.locator(".px-ocr")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a photo read by local OCR shows as a chip, and the text recognised in it is kept apart from the question", async () => {
  test.setTimeout(300000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-photo-"));
  installTessdata(userData, staged!);
  // The recorded model cannot read images and no other tool is signed in, so the photo is the case local OCR is for.
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_REPLY: "Ecco la risposta." } });
  try {
    await setUp(app, userData, async () => {
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "Salta" }).click();
      await fromChiediToExams(page);
      return page;
    });
    const page = await app.firstWindow();
    await page.evaluate(() => window.pyxis.setAppearance("light"));
    await page.evaluate(() => window.pyxis.invoke("sources.ocrData", { consent: true }));
    const [drawn] = await drawScanPages(page);
    const photo = join(userData, "lavagna.png");
    writeFileSync(photo, drawn!);
    await app.evaluate((_electron, selected) => {
      process.env["PYXIS_E2E_FILE"] = selected;
    }, photo);
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.getByRole("button", { name: "Aggiungi un file o una formula" }).click();
    await clickSettled(page, page.getByRole("menuitem", { name: "Allega file o immagine" }));
    await expect(page.locator(".ask-attachments li").filter({ hasText: "lavagna.png" })).toBeVisible();
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Cosa c'è scritto sulla lavagna?");
    await box.press("Enter");
    const bubble = page.locator(".px-msg-user");
    // A photo has nothing to open, so its chip is plain text.
    await expect(bubble.getByText("lavagna.png")).toBeVisible();
    await expect(page.getByText("Ecco la risposta.")).toBeVisible();
    await saveShot(page, "chat-attachments/4-photo-text-is-not-in-the-bubble.png");
    // The bubble shows the question and the file, never what OCR read from the photo.
    await expect(bubble).toContainText("Cosa c'è scritto sulla lavagna?");
    await expect(bubble).not.toContainText(/FORCE|MASS|ACCELERATION/i);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { readOnly: true, timeout: 10000 });
    try {
      expect(db.prepare("SELECT body FROM messages WHERE role = 'user'").all()).toEqual([{ body: "Cosa c'è scritto sulla lavagna?" }]);
      const [kept] = db.prepare("SELECT name, kind, recognised FROM attachments WHERE kind = 'photo'").all() as Array<{
        name: string;
        kind: string;
        recognised: string;
      }>;
      expect(kept).toMatchObject({ name: "lavagna.png", kind: "photo" });
      expect(kept!.recognised.toUpperCase()).toContain("FORCE");
    } finally {
      db.close();
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
