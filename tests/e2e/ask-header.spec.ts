import {
  expect,
  test,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";

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
  await expect(page).toHaveURL(/#\/exams$/);
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  return { app, page, userData, db };
}

async function finish(app: ElectronApplication, userData: string, db: DatabaseSync) {
  db.close();
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}

test("Ask: starter prompts from the plans, the title in the header, and a pasted screenshot", async () => {
  test.setTimeout(120000);
  const { app, page, userData, db } = await launch();
  try {
    db.exec(`
      INSERT INTO subjects(id,name,position,created_at) VALUES('s-fis','Fisica',0,1);
      INSERT INTO sources(id,kind,title,status,library,created_at,updated_at) VALUES('src-fis','excerpt','Appunti di fisica','ready',1,1,1);
      INSERT INTO plans(id,subject_id,title,status,content_language,target,created_at,updated_at) VALUES('p-fis','s-fis','Fisica 1','ready','it',0.75,1,1);
      INSERT INTO plan_sources(plan_id,source_id) VALUES('p-fis','src-fis');
      INSERT INTO topics(id,plan_id,title,position,created_at) VALUES('t1','p-fis','Cinematica',0,1),('t2','p-fis','Dinamica',1,1);
    `);
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.reload();

    // An empty chat suggests questions on the plan's topics and says how to attach material.
    const starters = page.getByRole("list", { name: "Domande suggerite" });
    await expect(starters.getByRole("button")).toHaveText([
      "Spiegami i concetti chiave di Cinematica",
      "Fammi 3 domande su Dinamica",
      "Dammi un esercizio su Cinematica",
    ]);
    await expect(page.getByText(/incolla uno screenshot o trascina qui i file/)).toBeVisible();
    // The drawer no longer repeats New chat; the header has the only one.
    await expect(page.getByRole("button", { name: "Nuova chat" })).toHaveCount(1);

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

    // A starter asks at once, with the plan's subject; the pasted image stays for the next message.
    await starters.getByRole("button", { name: "Spiegami i concetti chiave di Cinematica" }).click();
    await expect(page.getByText("Fammi un esempio")).toBeVisible({ timeout: 30000 });
    await expect(page.getByAltText("Immagine incollata")).toBeVisible();
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
    await page.getByRole("button", { name: "Apri le chat" }).click();
    await expect(page.getByRole("list", { name: "Chat" }).getByRole("button", { name: "Cinematica di base", exact: true })).toBeVisible();
  } finally {
    await finish(app, userData, db);
  }
});

test("Ask: the chat list groups by date and filters by subject with the search; a long chat opens at its end", async () => {
  test.setTimeout(120000);
  const { app, page, userData, db } = await launch();
  try {
    const now = Date.now();
    db.exec(`
      INSERT INTO subjects(id,name,position,created_at) VALUES('s-an','Analisi',0,1),('s-fis','Fisica',1,1);
      INSERT INTO chats(id,title,subject,created_at,updated_at) VALUES
        ('c-today','Moto rettilineo','Fisica',${now},${now}),
        ('c-an','Limiti notevoli','Analisi',1,2),
        ('c-old','Moto circolare','Fisica',1,1),
        ('c-free','Domanda libera',NULL,1,1);
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
    await page.getByRole("button", { name: "Apri le chat" }).click();

    const list = page.getByRole("list", { name: "Chat" });
    await expect(list.getByRole("heading")).toHaveText(["Oggi", "Meno recenti"]);
    await expect(list.getByRole("listitem")).toHaveCount(4);

    // The subject filter narrows the list, and the search within it.
    const filter = page.getByRole("combobox", { name: "Filtra per materia" });
    await filter.click();
    await page.getByRole("option", { name: "Fisica" }).click();
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await page.getByRole("textbox", { name: "Cerca nelle chat" }).fill("moto");
    await expect(page.getByRole("list", { name: "Risultati della ricerca" }).getByRole("listitem")).toHaveCount(2);
    await expect(page.getByRole("button", { name: /Limiti notevoli/ })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Cerca nelle chat" }).fill("funzione");
    await expect(page.getByText("Nessuna chat di Fisica contiene “funzione”.")).toBeVisible();
    await page.getByRole("textbox", { name: "Cerca nelle chat" }).fill("");

    // A long chat opens with its last messages; older ones join when the student scrolls up to them.
    await list.getByRole("button", { name: "Moto rettilineo", exact: true }).click();
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

test("Ask: a capped chat search still finds older chats in the subject the list is filtered to", async () => {
  test.setTimeout(120000);
  const { app, page, userData, db } = await launch();
  try {
    db.exec(`INSERT INTO subjects(id,name,position,created_at) VALUES('s-an','Analisi',0,1),('s-fis','Fisica',1,1);`);
    const chat = db.prepare("INSERT INTO chats(id,title,subject,created_at,updated_at) VALUES(?,?,?,?,?)");
    // Two old Fisica chats, then more recent Analisi ones than one search shows.
    chat.run("c-fis-1", "Derivata della velocità", "Fisica", 1, 1);
    chat.run("c-fis-2", "Derivata dello spazio", "Fisica", 2, 2);
    for (let i = 0; i < 55; i += 1) chat.run(`c-an-${i}`, `Derivata ${i}`, "Analisi", 100 + i, 100 + i);
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.reload();
    await page.getByRole("button", { name: "Apri le chat" }).click();
    await page.getByRole("combobox", { name: "Filtra per materia" }).click();
    await page.getByRole("option", { name: "Fisica" }).click();
    await page.getByRole("textbox", { name: "Cerca nelle chat" }).fill("derivata");
    const results = page.getByRole("list", { name: "Risultati della ricerca" }).getByRole("listitem");
    await expect(results).toHaveCount(2);
    await expect(page.getByText(/Aggiungi una parola per restringere la ricerca/)).toHaveCount(0);
  } finally {
    await finish(app, userData, db);
  }
});
