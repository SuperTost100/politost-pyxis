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
    await expect(chip).not.toContainText("Leggo");
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
    await expect(chips.filter({ hasText: /Leggo|supera|non riesce|fermata/ })).toHaveCount(0);
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

/** A sparse file of `megabytes` that core takes a moment to register. */
function sparse(path: string, megabytes: number) {
  writeFileSync(path, "%PDF-1.7 ");
  const fd = openSync(path, "r+");
  ftruncateSync(fd, megabytes * 1024 * 1024);
  closeSync(fd);
}

test("a file being attached when the student moves to another chat stays in the draft it was picked for", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  const dir = mkdtempSync(join(tmpdir(), "pyxis-chat-files-"));
  try {
    const big = join(dir, "dispensa.pdf");
    sparse(big, 150);
    const other = await page.evaluate(() =>
      window.pyxis.invoke("chats.seed", { kind: "passage", title: "Altra chat", body: "Un passaggio." }),
    );
    await pick(app, big);
    await attach(page);
    // Core is still registering the file. The student opens the other chat.
    await page.evaluate((id) => {
      location.hash = `/ask/${id}`;
    }, other.chatId);
    await expect(page).toHaveURL(new RegExp(`#/ask/${other.chatId}`));
    await expect.poll(() => rows(userData, "SELECT draft FROM held_files").length, { timeout: 30000 }).toBe(1);
    // It was picked for the new chat's draft: the other chat's composer has no file, and the next send there carries none.
    await expect(page.locator(".ask-attachments")).toHaveCount(0);
    expect(rows<{ draft: string }>(userData, "SELECT draft FROM held_files")).toEqual([{ draft: "" }]);
    await page.getByRole("link", { name: "Nuova chat" }).click();
    await expect(page.locator(".ask-attachments li").filter({ hasText: "dispensa.pdf" })).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Enter pressed while several picked files are still being attached sends the question with all of them", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  const dir = mkdtempSync(join(tmpdir(), "pyxis-chat-files-"));
  try {
    const paths = ["uno.pdf", "due.pdf", "tre.pdf"].map((name) => join(dir, name));
    for (const path of paths) sparse(path, 150);
    await app.evaluate(({ dialog }, selected) => {
      delete process.env["PYXIS_E2E_FILE"];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: selected });
    }, paths);
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Riassumi");
    await attach(page);
    // The first file is in the composer and the others are still being registered when Enter is pressed.
    await expect(page.locator(".ask-attachments li")).toHaveCount(1, { timeout: 30000 });
    await box.press("Enter");
    await expect(page).toHaveURL(/#\/ask\/.+/, { timeout: 60000 });
    // The files are not real PDFs, so each one is sent without and named. All three being named means all three went with
    // the question: it waited for the pick to finish registering.
    for (const name of ["uno.pdf", "due.pdf", "tre.pdf"])
      await expect(page.getByText(`Ho mandato la domanda senza ${name}.`)).toBeVisible({ timeout: 60000 });
    // Nothing is left behind for the next draft.
    await expect(page.locator(".ask-attachments")).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a send that waits for files belongs to its draft: the composer works and stops, and another chat's draft is left alone", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  const dir = mkdtempSync(join(tmpdir(), "pyxis-chat-files-"));
  try {
    const paths = ["uno.pdf", "due.pdf", "tre.pdf"].map((name) => join(dir, name));
    for (const path of paths) sparse(path, 150);
    const other = await page.evaluate(() =>
      window.pyxis.invoke("chats.seed", { kind: "passage", title: "Altra chat", body: "Un passaggio." }),
    );
    await app.evaluate(({ dialog }, selected) => {
      delete process.env["PYXIS_E2E_FILE"];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: selected });
    }, paths);
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Riassumi");
    await attach(page);
    await expect(page.locator(".ask-attachments li")).toHaveCount(1, { timeout: 30000 });
    await box.press("Enter");
    // While the send waits for the pick, the composer shows it working, with a way to stop, and is not editable.
    const stop = page.getByRole("button", { name: "Interrompi", exact: true });
    await expect(stop).toBeVisible();
    await expect(box).toHaveText("");
    // The student opens another chat and types there: the send that is waiting must not touch that draft.
    await page.evaluate((id) => {
      location.hash = `/ask/${id}`;
    }, other.chatId);
    await expect(page).toHaveURL(new RegExp(`#/ask/${other.chatId}`));
    await box.fill("Una bozza di questa chat");
    // The other chat is only seeded, so the one row is the chat the waiting send made.
    await expect.poll(() => rows(userData, "SELECT id FROM chats").length, { timeout: 60000 }).toBe(1);
    await expect(box).toHaveText("Una bozza di questa chat");
    expect(await page.evaluate((id) => sessionStorage.getItem(`pyxis-draft:${id}`), other.chatId)).toBe("Una bozza di questa chat");
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stop while a send waits for its files puts the question and the chips back", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  const dir = mkdtempSync(join(tmpdir(), "pyxis-chat-files-"));
  try {
    const paths = ["uno.pdf", "due.pdf", "tre.pdf"].map((name) => join(dir, name));
    for (const path of paths) sparse(path, 150);
    await app.evaluate(({ dialog }, selected) => {
      delete process.env["PYXIS_E2E_FILE"];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: selected });
    }, paths);
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Riassumi");
    await attach(page);
    await expect(page.locator(".ask-attachments li")).toHaveCount(1, { timeout: 30000 });
    await box.press("Enter");
    const stop = page.getByRole("button", { name: "Interrompi", exact: true });
    await stop.click();
    await expect(stop).toHaveCount(0);
    await expect(box).toHaveText("Riassumi");
    await expect(page.locator(".ask-attachments li")).toHaveCount(3, { timeout: 60000 });
    expect(rows(userData, "SELECT id FROM chats")).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("files picked while a new chat's first reply is written follow that chat, with Chiedi on screen or not", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch({ PYXIS_E2E_REPLY_DELAY: "6000" });
  const dir = mkdtempSync(join(tmpdir(), "pyxis-chat-files-"));
  try {
    const note = join(dir, "dopo.txt");
    writeFileSync(note, "Un file scelto mentre la risposta si scrive.");
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Prima domanda");
    await box.press("Enter");
    await expect(page.getByRole("button", { name: "Interrompi", exact: true })).toBeVisible();
    await pick(app, note);
    await attach(page);
    await expect(page.locator(".ask-attachments li").filter({ hasText: "dopo.txt" })).toBeVisible();
    // Another page is opened while the reply is still being written.
    await page.evaluate(() => {
      location.hash = "/exams";
    });
    await expect.poll(() => rows(userData, "SELECT id FROM messages WHERE role = 'assistant'").length, { timeout: 60000 }).toBe(1);
    const chatId = rows<{ id: string }>(userData, "SELECT id FROM chats")[0]!.id;
    expect(rows<{ draft: string }>(userData, "SELECT draft FROM held_files")).toEqual([{ draft: chatId }]);
    // The new chat's composer is empty, and the file is in the finished chat's.
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await expect(page.getByRole("textbox", { name: "Messaggio" })).toBeVisible();
    await expect(page.locator(".ask-attachments")).toHaveCount(0);
    await page.evaluate((id) => {
      location.hash = `/ask/${id}`;
    }, chatId);
    await expect(page.locator(".ask-attachments li").filter({ hasText: "dopo.txt" })).toBeVisible();
    // Deleting that chat takes the file with it, and nothing of the New chat page is touched.
    await page.evaluate((id) => window.pyxis.invoke("chats.delete", { chatId: id }), chatId);
    await expect.poll(() => rows(userData, "SELECT id FROM held_files").length).toBe(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a question stopped before any answer is taken back with its files, and sending it again answers it and lets them go", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch({ PYXIS_E2E_REPLY_DELAY: "6000" });
  const dir = mkdtempSync(join(tmpdir(), "pyxis-chat-files-"));
  try {
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Ciao");
    await box.press("Enter");
    await expect(page).toHaveURL(/#\/ask\/.+/, { timeout: 30000 });
    await expect(page.getByText(REPLY.slice(0, 20))).toBeVisible({ timeout: 30000 });
    const note = join(dir, "appunti.txt");
    writeFileSync(note, "Il calore si trasmette per conduzione.");
    await pick(app, note);
    await attach(page);
    await expect(page.locator(".ask-attachments li").filter({ hasText: "appunti.txt" })).toBeVisible();
    await expect.poll(() => rows(userData, "SELECT status FROM sources WHERE library = 0")).toEqual([{ status: "ready" }]);
    await box.fill("Spiega gli appunti");
    await box.press("Enter");
    const stop = page.getByRole("button", { name: "Interrompi", exact: true });
    await expect(stop).toBeVisible();
    await stop.click();
    // The question is taken back: the composer gets its text and its file chip, and the chat keeps no copy.
    await expect(page.locator(".ask-attachments li").filter({ hasText: "appunti.txt" })).toBeVisible();
    await expect(box).toHaveText("Spiega gli appunti");
    expect(rows(userData, "SELECT id FROM attachments WHERE kind = 'document'")).toEqual([]);
    // Sent again, the question is answered with its file, and the chip that came back goes.
    await box.press("Enter");
    await expect(page.locator(".ask-attachments")).toHaveCount(0, { timeout: 30000 });
    // The files are let go once the answer is stored, which the delayed reply makes later than the chip going.
    await expect.poll(() => rows(userData, "SELECT id FROM held_files"), { timeout: 30000 }).toEqual([]);
    expect(rows(userData, "SELECT id FROM attachments WHERE kind = 'document'")).toHaveLength(1);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the notice of files sent without does not follow the student to another chat", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  const dir = mkdtempSync(join(tmpdir(), "pyxis-chat-files-"));
  try {
    const bad = join(dir, "rotto.pdf");
    sparse(bad, 1);
    const other = await page.evaluate(() =>
      window.pyxis.invoke("chats.seed", { kind: "passage", title: "Altra chat", body: "Un passaggio." }),
    );
    await pick(app, bad);
    await attach(page);
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Riassumi");
    await expect(page.locator(".ask-attachments li").filter({ hasText: "rotto.pdf" })).toContainText(/non riesce|leggere/, { timeout: 30000 });
    await box.press("Enter");
    await expect(page.getByText("Ho mandato la domanda senza rotto.pdf.")).toBeVisible({ timeout: 30000 });
    await page.evaluate((id) => {
      location.hash = `/ask/${id}`;
    }, other.chatId);
    await expect(page).toHaveURL(new RegExp(`#/ask/${other.chatId}`));
    await expect(page.getByText("Ho mandato la domanda senza rotto.pdf.")).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(dir, { recursive: true, force: true });
  }
});
