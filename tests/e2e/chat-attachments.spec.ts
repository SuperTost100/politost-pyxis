import { expect, test, type Page } from "@playwright/test";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis, setUp } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { clickSettled } from "./settled";
import { saveShot } from "./shots";

/*
 * A file attached to a chat is read when it is attached, by the Library's own import job, and the question that carries it
 * lists it. Nothing here calls a model: the reply is a recorded one.
 */

/** A reply as a model gives one to a question about the note: it cites the attached file. */
const REPLY = "Gli appunti dicono che il calore si trasmette per conduzione [P1].";

async function launch(extra: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-attachments-"));
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_REPLY: REPLY, ...extra } });
  return setUp(app, userData, async () => {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.evaluate(() => window.pyxis.setAppearance("light"));
    return { app, page, userData };
  });
}

/** The next time the paperclip asks the system for a file, it gets this one. */
const pick = (app: Awaited<ReturnType<typeof launch>>["app"], path: string) =>
  app.evaluate((_electron, selected) => {
    process.env["PYXIS_E2E_FILE"] = selected;
  }, path);

async function attach(page: Page) {
  await page.getByRole("button", { name: "Aggiungi un file o una formula" }).click();
  await clickSettled(page, page.getByRole("menuitem", { name: "Allega file o immagine" }));
}

const rows = <T>(userData: string, sql: string): T[] => {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { readOnly: true, timeout: 10000 });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
};

test("a document is read when it is attached, the question lists it, and it opens from there", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  const dir = mkdtempSync(join(tmpdir(), "pyxis-chat-files-"));
  try {
    const note = join(dir, "appunti.txt");
    writeFileSync(note, "La forza è massa per accelerazione. Il calore si trasmette per conduzione.");
    await pick(app, note);
    await attach(page);
    const chip = page.locator(".ask-attachments li").filter({ hasText: "appunti.txt" });
    await expect(chip).toBeVisible();
    // Read already: the hidden copy exists before any question is sent, and the Library does not list it.
    await expect
      .poll(() => rows<{ status: string; library: number }>(userData, "SELECT status, library FROM sources"))
      .toEqual([{ status: "ready", library: 0 }]);
    await expect(chip).not.toContainText("Lettura");
    expect(await page.evaluate(() => window.pyxis.invoke("sources.list", {}))).toEqual([]);

    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Riassumi gli appunti");
    await box.press("Enter");
    await expect(page).toHaveURL(/#\/ask\/.+/);
    // The question shows its file as a chip, in the thread and not in the composer.
    const sent = page.locator(".ask-sent-files");
    await expect(sent.getByRole("button", { name: "appunti.txt" })).toBeVisible();
    await expect(page.locator(".ask-attachments")).toHaveCount(0);
    // The reply cites the attached file, and the line above it says so instead of claiming general knowledge.
    await expect(page.getByText("Ho usato il file che hai allegato")).toBeVisible();
    await expect(page.getByText(/quello che so in generale/)).toHaveCount(0);
    await saveShot(page, "chat-attachments/3-sent-message-lists-its-file.png");
    // It stays after the reply, and after the page is read again from core.
    await expect(page.getByText("Gli appunti dicono che il calore si trasmette per conduzione")).toBeVisible();
    await page.reload();
    await expect(sent.getByRole("button", { name: "appunti.txt" })).toBeVisible();
    // The chip opens the file the way a citation does.
    await clickSettled(page, sent.getByRole("button", { name: "appunti.txt" }));
    await expect(page.getByText(/Il calore si trasmette per conduzione/).first()).toBeVisible();
    const stored = await page.evaluate(() =>
      window.pyxis.invoke("chats.read", { chatId: location.hash.split("/").at(-1)! }),
    );
    expect(stored.messages[0]).toMatchObject({
      body: "Riassumi gli appunti",
      files: [expect.objectContaining({ name: "appunti.txt", kind: "document" })],
    });
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file Pyxis cannot take says so on its own chip, which goes away with it, and a banner can be closed", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  const dir = mkdtempSync(join(tmpdir(), "pyxis-chat-files-"));
  try {
    // 300 MB is past the 256 MB the Library reads for a document. A sparse file costs nothing to make.
    const huge = join(dir, "enorme.pdf");
    writeFileSync(huge, "%PDF-1.7");
    const fd = openSync(huge, "r+");
    ftruncateSync(fd, 300 * 1024 * 1024);
    closeSync(fd);
    await pick(app, huge);
    await attach(page);
    const chip = page.locator(".ask-attachments li").filter({ hasText: "enorme.pdf" });
    await expect(chip).toContainText("Il file supera i 256 MB che Pyxis legge per un documento.");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem", { name: "Allega file o immagine" })).toHaveCount(0);
    await saveShot(page, "chat-attachments/2-large-file-says-why-on-its-chip.png");
    // The reason is on the chip, not in a banner that outlives it.
    await expect(page.getByRole("alert")).toHaveCount(0);
    await chip.getByRole("button", { name: "Rimuovi enorme.pdf" }).click();
    await expect(chip).toHaveCount(0);
    expect(rows(userData, "SELECT id FROM sources")).toEqual([]);

    // A banner that is still raised for another reason has a close control, reachable from the keyboard.
    await app.evaluate(({ dialog }) => {
      delete process.env["PYXIS_E2E_FILE"];
      dialog.showOpenDialog = async () => {
        throw new Error("picker-failed");
      };
    });
    await attach(page);
    const banner = page.getByRole("alert");
    await expect(banner).toBeVisible();
    const close = banner.getByRole("button", { name: "Chiudi" });
    await close.focus();
    await expect(close).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(banner).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a send that is stopped puts its files back as ready chips, and sending again carries them", async () => {
  test.setTimeout(120000);
  // The recorded reply waits before its first words, so Stop lands before any text: the turn fails after it stored its question.
  const { app, page, userData } = await launch({ PYXIS_E2E_REPLY_DELAY: "6000" });
  const dir = mkdtempSync(join(tmpdir(), "pyxis-chat-files-"));
  try {
    const note = join(dir, "appunti.txt");
    const second = join(dir, "dispensa.txt");
    writeFileSync(note, "Il calore si trasmette per conduzione.");
    writeFileSync(second, "L'energia si conserva in un sistema chiuso.");
    const box = page.getByRole("textbox", { name: "Messaggio" });
    for (const path of [note, second]) {
      await pick(app, path);
      await attach(page);
    }
    const chips = page.locator(".ask-attachments li");
    await expect(chips).toHaveCount(2);
    await expect.poll(() => rows(userData, "SELECT status FROM sources WHERE status = 'ready'").length).toBe(2);
    await box.fill("Riassumi i due file");
    await box.press("Enter");
    const stop = page.getByRole("button", { name: "Interrompi", exact: true });
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(stop).toHaveCount(0);
    // The question and both files are back in the composer, read already: no reading, no failure, nothing to attach again.
    await expect(box).toHaveText("Riassumi i due file");
    await expect(chips).toHaveCount(2);
    await expect(chips.filter({ hasText: "appunti.txt" })).toBeVisible();
    await expect(chips.filter({ hasText: "dispensa.txt" })).toBeVisible();
    await expect(chips.filter({ hasText: /Lettura|supera|non riesce|fermata/ })).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    // Core still holds them, so a window reload finds them too.
    await page.reload();
    await expect(chips).toHaveCount(2);

    await box.fill("Riassumi i due file");
    await box.press("Enter");
    await expect(page).toHaveURL(/#\/ask\/.+/, { timeout: 30000 });
    const sent = page.locator(".ask-sent-files");
    await expect(sent.getByRole("button", { name: "appunti.txt" })).toBeVisible({ timeout: 30000 });
    await expect(sent.getByRole("button", { name: "dispensa.txt" })).toBeVisible();
    await expect(page.getByText("Gli appunti dicono che il calore si trasmette per conduzione")).toBeVisible({ timeout: 30000 });
    // Each file is one hidden source and one row on the question: nothing was read or stored twice.
    expect(rows(userData, "SELECT id FROM sources WHERE library = 0")).toHaveLength(2);
    expect(rows(userData, "SELECT id FROM attachments WHERE kind = 'document'")).toHaveLength(2);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("after a quit, a file that was attached and never sent is gone, and one a message carries stays", async () => {
  test.setTimeout(180000);
  const { app, page, userData } = await launch();
  const dir = mkdtempSync(join(tmpdir(), "pyxis-chat-files-"));
  try {
    const sentNote = join(dir, "inviato.txt");
    const unsentNote = join(dir, "mai-inviato.txt");
    writeFileSync(sentNote, "Il calore si trasmette per conduzione.");
    writeFileSync(unsentNote, "Un testo che nessuna domanda ha portato.");
    await pick(app, sentNote);
    await attach(page);
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Riassumi");
    await box.press("Enter");
    await expect(page.locator(".ask-sent-files").getByRole("button", { name: "inviato.txt" })).toBeVisible();
    // A second file is attached to the next question and the app quits before it is sent.
    await pick(app, unsentNote);
    await attach(page);
    await expect(page.locator(".ask-attachments li").filter({ hasText: "mai-inviato.txt" })).toBeVisible();
    await expect.poll(() => rows(userData, "SELECT id FROM sources WHERE library = 0").length).toBe(2);
    await app.close();

    const reopened = await launchPyxis({ userData, env: { PYXIS_E2E_REPLY: REPLY } });
    try {
      await setUp(reopened, userData, () => reopened.firstWindow());
      // Core removes the copy no message holds when it starts; the sent file and its message stay.
      await expect
        .poll(() => rows<{ title: string }>(userData, "SELECT title FROM sources WHERE library = 0"))
        .toEqual([{ title: "inviato" }]);
      expect(rows(userData, "SELECT id FROM attachments WHERE kind = 'document'")).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  } finally {
    removeTestFolder(userData);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Free up space run before sending leaves the attached files as they were, and they can be sent", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  const dir = mkdtempSync(join(tmpdir(), "pyxis-chat-files-"));
  try {
    const note = join(dir, "appunti.txt");
    writeFileSync(note, "Il calore si trasmette per conduzione.");
    await pick(app, note);
    await attach(page);
    const chip = page.locator(".ask-attachments li").filter({ hasText: "appunti.txt" });
    await expect(chip).toBeVisible();
    await expect.poll(() => rows(userData, "SELECT status FROM sources WHERE library = 0")).toEqual([{ status: "ready" }]);
    // Settings › Data › Free up space, before anything is sent: the held copy is not an orphan.
    await page.evaluate(() => window.pyxis.invoke("plans.freeSpace", {}));
    expect(rows(userData, "SELECT status FROM sources WHERE library = 0")).toEqual([{ status: "ready" }]);
    await expect(chip).not.toContainText(/fermata|non riesce/);
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Riassumi gli appunti");
    await box.press("Enter");
    await expect(page.locator(".ask-sent-files").getByRole("button", { name: "appunti.txt" })).toBeVisible({ timeout: 30000 });
    await expect(page.getByText("Ho usato il file che hai allegato")).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dir, { recursive: true, force: true });
  }
});
