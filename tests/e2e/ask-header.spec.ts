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
import { atRest } from "./settled";
import { saveShot } from "./shots";

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
  // The recent chats show beside the page from 1100px; Windows runners scale the default window below that.
  await page.setViewportSize({ width: 1280, height: 832 });
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

    // A new chat leaves the subject to Pyxis; the student can choose one from the chip in the header.
    await expect(page.locator(".ask-bar").getByRole("button", { name: /^Materia: sceglie Pyxis/ })).toBeVisible();

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

    // The image comes off again, and the first question goes out.
    await page.getByRole("button", { name: "Rimuovi Immagine incollata" }).click();
    await expect(page.getByAltText("Immagine incollata")).toHaveCount(0);
    await page.getByRole("textbox", { name: "Messaggio" }).fill("Spiegami i concetti chiave di Cinematica");
    await page.getByRole("textbox", { name: "Messaggio" }).press("Enter");
    await expect(page.getByText("Fammi un esempio")).toBeVisible({ timeout: 30000 });

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

    // Seven chats all fit in the sidebar, so it has no "Tutte le chat" link. Searching everything shows six chats, then a
    // row that lists them all, which groups them under Today and Earlier, and the search narrows them by message text.
    await expect(page.getByRole("button", { name: "Tutte le chat" })).toHaveCount(0);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    const finder = page.getByRole("dialog", { name: "Cerca" });
    const chatGroup = finder.getByRole("group", { name: "Chat" });
    await expect(chatGroup.getByRole("option")).toHaveCount(7);
    await chatGroup.getByRole("option", { name: "Tutte le chat" }).click();
    await expect(finder).toBeVisible();
    await expect(finder.getByRole("combobox", { name: "Cerca" })).toHaveAttribute("placeholder", "Cerca nelle chat");
    await expect(finder.locator(".px-finder-label")).toHaveText(["Oggi", "Prima"]);
    await expect(finder.getByRole("option")).toHaveCount(7);
    await expect(finder.getByRole("option", { name: "Tutte le chat" })).toHaveCount(0);
    await finder.getByRole("combobox", { name: "Cerca" }).fill("circolare");
    await expect(finder.getByRole("option")).toHaveCount(1);
    await expect(finder.getByRole("option", { name: /^Moto circolare/ })).toBeVisible();
    await finder.getByRole("combobox", { name: "Cerca" }).fill("");
    await expect(finder.getByRole("option")).toHaveCount(7);
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


test("Ask: the subject chip never overlaps Attività, in either language, at any width, with a long subject, large text and the source panel open", async () => {
  test.setTimeout(240000);
  const { app, page, userData, db } = await launch();
  try {
    const now = Date.now();
    const subject = "Fisica dei sistemi complessi e metodi matematici per l’ingegneria";
    seedSubjects(db, [{ id: "s-fis", name: subject }]);
    seedSource(db, {
      id: "src-fis",
      title: "Appunti di fisica",
      document: { id: "doc-fis" },
      passages: [{ id: "pa-1", text: "La forza è il prodotto di massa e accelerazione.", locator: { chapter: 1, paragraph: "p1" }, section: "1. Dinamica" }],
    });
    db.exec(`
      INSERT INTO chats(id,title,subject,created_at,updated_at) VALUES ('c-1','Seconda legge di Newton','${subject}',${now},${now});
      INSERT INTO messages(id,chat_id,role,body,created_at) VALUES ('m1','c-1','user','Come calcolo la forza?',${now});
    `);
    // Jobs that run and jobs that wait for the student widen Attività past its 46px, which is when the chip met it.
    const job = db.prepare(
      "INSERT INTO jobs(id,kind,params_json,state,progress,error,created_at,updated_at) VALUES(?,'demo','{}',?,0,?,?,?)",
    );
    for (const id of ["run-1", "run-2"]) job.run(id, "running", null, now, now);
    for (const id of ["fix-1", "fix-2", "fix-3"]) job.run(id, "failed", "engine-failed", now, now);
    await page.evaluate(() => {
      location.hash = "/ask/c-1";
    });
    await page.reload();
    const chip = page.locator(".ask-bar .ask-subject-chip");
    const tools = page.locator(".px-corner-tools");
    const apart = async (label: string) => {
      await expect(chip, label).toBeVisible();
      await atRest(chip);
      const [a, b] = [(await chip.boundingBox())!, (await tools.boundingBox())!];
      // Attività has grown past its resting 46px, so the jobs are counted and the check means something.
      expect(b.width, `${label}: Attività shows its counts`).toBeGreaterThan(70);
      expect(
        a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
        `${label}: the chip (${Math.round(a.x)}–${Math.round(a.x + a.width)}) stays clear of Attività (${Math.round(b.x)}–${Math.round(b.x + b.width)})`,
      ).toBe(true);
    };
    for (const text of ["md", "lg"] as const) {
      await page.evaluate((textSize) => window.pyxis.invoke("profile.save", { dyslexia: false, textSize }), text);
      for (const language of ["it", "en"]) {
        await page.evaluate((language) => localStorage.setItem("pyxis.lang", language), language);
        await page.reload();
        for (const panel of [false, true]) {
          if (panel)
            await page.evaluate(() =>
              window.dispatchEvent(new CustomEvent("pyxis:source-viewer", { detail: { passageId: "pa-1" } })),
            );
          else await page.keyboard.press("Escape");
          for (const width of [960, 1180, 1280, 1440]) {
            await page.setViewportSize({ width, height: 800 });
            await apart(`${language}, ${text} text, ${width}px${panel ? ", source panel open" : ""}`);
            await saveShot(page, `ask-chip-${language}-${text}-${width}${panel ? "-panel" : ""}.png`);
          }
        }
        await page.keyboard.press("Escape");
      }
    }
  } finally {
    await finish(app, userData, db);
  }
});
