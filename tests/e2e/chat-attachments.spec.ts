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

async function launch(extra: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-attachments-"));
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_REPLY: "Ecco la risposta.", ...extra } });
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
    await saveShot(page, "chat-attachments/3-sent-message-lists-its-file.png");
    // It stays after the reply, and after the page is read again from core.
    await expect(page.getByText("Ecco la risposta.")).toBeVisible();
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
