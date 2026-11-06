import {
  expect,
  test,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { answerNextMenu } from "./native-menu";

const REPLY = ["La cinematica descrive il moto: $v = \\frac{dx}{dt}$.", "", "<followups>", "Fammi un esempio", "</followups>"].join(
  "\n",
);

// A 1x1 PNG, as a screenshot pasted from the clipboard would arrive.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function launch() {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-ask-header-"));
  const env = {
    PYXIS_E2E_REPLY: REPLY,
  };
  const app = await launchPyxis({ userData, env });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  return { app, page, userData, db };
}

async function finish(app: ElectronApplication, userData: string, db: DatabaseSync) {
  db.close();
  await app.close();
  removeTestFolder(userData);
}

test("Ask: Home has no suggested questions, the title in the header, and a pasted screenshot", async () => {
  test.setTimeout(120000);
  const { app, page, userData, db } = await launch();
  try {
    seedSubjects(db, [{ id: "s-fis", name: "Fisica" }]);
    seedSource(db, { id: "src-fis", title: "Appunti di fisica" });
    seedPlan(db, {
      id: "p-fis",
      subjectId: "s-fis",
      title: "Fisica 1",
      language: "it",
      target: 0.75,
      sourceIds: ["src-fis"],
      topics: [{ id: "t1", title: "Cinematica" }, { id: "t2", title: "Dinamica" }],
    });
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.reload();

    // With one subject, a new chat starts on it and on its plan's source.
    await expect(page.getByRole("button", { name: /^Materia:/ })).toHaveText("Fisica");
    await expect(page.getByRole("button", { name: "1 fonte", exact: true })).toBeVisible();

    // Home is the greeting and the composer, with no suggested questions.
    await expect(page.locator(".ask-starters")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Cinematica|Dinamica/ })).toHaveCount(0);
    // The sidebar has the only New chat.
    await expect(page.getByRole("link", { name: "Nuova chat" })).toHaveCount(1);

    // A pasted screenshot is staged as an attachment, with its preview.
    await page.getByRole("textbox", { name: "Messaggio" }).click();
    await page.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], "image.png", { type: "image/png" }));
      document
        .querySelector(".px-composer-field")!
        .dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, PNG);
    await expect(page.getByAltText("Immagine incollata")).toBeVisible();
    await expect(page.getByRole("button", { name: "Rimuovi Immagine incollata" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Messaggio" })).toHaveText("");

    // A file dropped without a path on disk is refused with a note, not attached.
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(["x"], "nota.txt", { type: "text/plain" }));
      const target = document.querySelector(".ask-page")!;
      for (const type of ["dragenter", "dragover", "drop"])
        target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await expect(page.getByText(/Alcuni file sono stati saltati/)).toBeVisible();

    // The image comes off again, and the first question goes with the chat's subject.
    await page.getByRole("button", { name: "Rimuovi Immagine incollata" }).click();
    await expect(page.getByAltText("Immagine incollata")).toHaveCount(0);
    await page.getByRole("textbox", { name: "Messaggio" }).fill("Spiegami i concetti chiave di Cinematica");
    await page.getByRole("textbox", { name: "Messaggio" }).press("Enter");
    await expect(page.getByText("Fammi un esempio")).toBeVisible({ timeout: 30000 });
    const chat = await page.evaluate(() =>
      window.pyxis.invoke("chats.read", { chatId: location.hash.split("/").at(-1)! }),
    );
    expect((chat as { subject: string | null }).subject).toBe("Fisica");

    // The header names the open chat, and a click renames it: Esc cancels, Enter saves.
    const title = page.getByRole("button", { name: "Rinomina Spiegami i concetti chiave di Cinematica" });
    await expect(title).toBeVisible();
    await title.click();
    const field = page.getByRole("textbox", { name: "Nome della chat" });
    await field.fill("Scartato");
    await field.press("Escape");
    await title.click();
    await field.fill("Cinematica di base");
    await field.press("Enter");
    await expect(page.getByRole("button", { name: "Rinomina Cinematica di base" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Chat" }).getByRole("link", { name: /^Cinematica di base/ })).toBeVisible();
  } finally {
    await finish(app, userData, db);
  }
});

test("Ask: a new chat starts on the only subject, and on none once a second subject exists", async () => {
  test.setTimeout(120000);
  const { app, page, userData, db } = await launch();
  try {
    seedSubjects(db, [{ id: "s-fis", name: "Fisica" }]);
    seedSource(db, { id: "src-fis", title: "Appunti di fisica" });
    seedPlan(db, {
      id: "p-fis",
      subjectId: "s-fis",
      title: "Fisica 1",
      language: "it",
      target: 0.75,
      sourceIds: ["src-fis"],
      topics: [{ id: "t1", title: "Cinematica" }],
    });
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.reload();
    const box = page.getByRole("textbox", { name: "Messaggio" });
    const sentSubject = async () => {
      await expect(page).toHaveURL(/#\/ask\/.+/);
      await expect(page.getByText("Fammi un esempio")).toBeVisible({ timeout: 30000 });
      const chat = await page.evaluate(() =>
        window.pyxis.invoke("chats.read", { chatId: location.hash.split("/").at(-1)! }),
      );
      return (chat as { subject: string | null }).subject;
    };

    // A question typed at once goes out with the only subject.
    await box.fill("Che cos'è la velocità?");
    await box.press("Enter");
    expect(await sentSubject()).toBe("Fisica");

    // A subject added since the list was read counts: the next new chat has two and starts on none.
    await page.evaluate(() => window.pyxis.invoke("subjects.add", { name: "Chimica" }));
    await page.getByRole("link", { name: "Nuova chat" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    // The empty chat's greeting: the composer now belongs to the new chat.
    await expect(page.getByRole("heading", { level: 1, name: /^(Buongiorno|Buon pomeriggio|Buonasera)$/ })).toBeVisible();
    await box.fill("Che cos'è l'accelerazione?");
    await box.press("Enter");
    expect(await sentSubject()).toBeNull();
    await expect(page.getByRole("button", { name: /^Materia:/ })).toHaveText("Nessuna materia");
  } finally {
    await finish(app, userData, db);
  }
});

test("Ask: recent chats show each subject, All chats groups them by date and searches them, and a long chat opens at its end", async () => {
  test.setTimeout(120000);
  const { app, page, userData, db } = await launch();
  try {
    const now = Date.now();
    seedSubjects(db, [{ id: "s-an", name: "Analisi" }, { id: "s-fis", name: "Fisica" }]);
    db.exec(`
      INSERT INTO chats(id,title,subject,created_at,updated_at) VALUES
        ('c-today','Moto rettilineo','Fisica',${now},${now}),
        ('c-an','Limiti notevoli','Analisi',1,2),
        ('c-old','Moto circolare','Fisica',1,1),
        ('c-free','Domanda libera',NULL,1,1),
        ('c-x1','Vettori','Fisica',1,1),
        ('c-x2','Derivate','Analisi',1,1),
        ('c-x3','Integrali','Analisi',1,1);
      INSERT INTO messages(id,chat_id,role,body,created_at) VALUES
        ('m1','c-today','user','Che cos''è il moto rettilineo?',1),
        ('m2','c-an','user','Un limite sul moto di una funzione',1),
        ('m3','c-old','user','Il moto circolare uniforme',1);
    `);
    const insert = db.prepare("INSERT INTO messages(id,chat_id,role,body,grounding,created_at) VALUES(?,?,?,?,?,?)");
    for (let i = 1; i <= 15; i += 1) {
      insert.run(`q${i}`, "c-today", "user", `Domanda numero ${i}`, null, 10 + i * 2);
      insert.run(`r${i}`, "c-today", "assistant", `Risposta numero ${i}: $x_${i} = ${i}$.`, "general", 11 + i * 2);
    }
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.reload();

    // The sidebar lists the recent chats, each with its subject under the title; a chat without one shows the title
    // alone.
    const list = page.getByRole("list", { name: "Chat" });
    await expect(list.getByRole("listitem")).toHaveCount(7);
    await expect(list.getByRole("link", { name: /^Moto rettilineo/ })).toHaveText("Moto rettilineoFisica");
    await expect(list.getByRole("link", { name: /^Domanda libera/ })).toHaveText("Domanda libera");

    // All chats lists every chat under Today and Earlier, and the search narrows it by message text.
    await page.getByRole("button", { name: "Tutte le chat" }).click();
    const finder = page.getByRole("dialog", { name: "Cerca" });
    await expect(finder.locator(".px-finder-label")).toHaveText(["Oggi", "Prima"]);
    await expect(finder.getByRole("option")).toHaveCount(7);
    await finder.getByRole("combobox", { name: "Cerca" }).fill("circolare");
    await expect(finder.getByRole("option")).toHaveCount(1);
    await expect(finder.getByRole("option", { name: /^Moto circolare/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(finder).toBeHidden();

    // Searching everything shows six chats, then a row that lists them all, as "Tutte le chat" does where the
    // sidebar is folded.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    const chatGroup = finder.getByRole("group", { name: "Chat" });
    await expect(chatGroup.getByRole("option")).toHaveCount(7);
    await chatGroup.getByRole("option", { name: "Tutte le chat" }).click();
    await expect(finder).toBeVisible();
    await expect(finder.getByRole("combobox", { name: "Cerca" })).toHaveAttribute("placeholder", "Cerca nelle chat");
    await expect(finder.getByRole("option")).toHaveCount(7);
    await expect(finder.getByRole("option", { name: "Tutte le chat" })).toHaveCount(0);
    // Deleting from the search closes it first, so the confirmation can be reached.
    await answerNextMenu(app, "Elimina");
    await finder.getByRole("option", { name: /^Vettori/ }).click({ button: "right" });
    await expect(finder).toBeHidden();
    const confirm = page.getByRole("dialog", { name: "Eliminare questa chat?" });
    await confirm.getByRole("button", { name: "Annulla" }).click();
    await expect(confirm).toHaveCount(0);

    // A long chat opens with its last messages; older ones join when the student scrolls up to them.
    await list.getByRole("link", { name: /^Moto rettilineo/ }).click();
    await expect(page.getByText("Risposta numero 15", { exact: false })).toBeVisible();
    await expect(page.getByText("Domanda numero 1", { exact: true })).toHaveCount(0);
    const earlier = page.getByRole("button", { name: /^Mostra \d+ messaggi precedenti$/ });
    await expect(earlier).toBeVisible();
    await expect
      .poll(async () => {
        await page.evaluate(() => document.scrollingElement!.scrollTo({ top: 0 }));
        return page.getByText("Domanda numero 1", { exact: true }).count();
      })
      .toBe(1);
    await expect(earlier).toHaveCount(0);
    await expect(page.getByText("Che cos'è il moto rettilineo?")).toBeAttached();
  } finally {
    await finish(app, userData, db);
  }
});

