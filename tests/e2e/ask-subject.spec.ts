import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams, toLibrary } from "./doors";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { atRest } from "./settled";
import { saveShot } from "./shots";

// The recorded engine answers every question with this reply, which cites the first passage it was given.
const REPLY = ["Il campo è radiale e vale λ/(2π ε₀ r) [P1].", "", "<followups>", "E il potenziale?", "</followups>"].join("\n");

async function launch(env: Record<string, string> = { PYXIS_E2E_REPLY: REPLY }) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-ask-subject-"));
  const app = await launchPyxis({ userData, env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 832 });
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  return { app, page, userData };
}

/** Three subjects, each with a file and its passages: only Fisica 2 talks about the field of a charged wire. */
function seedLibrary(userData: string) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  seedSubjects(db, [
    { id: "s-an", name: "Analisi 1" },
    { id: "s-fis", name: "Fisica 2" },
    { id: "s-sto", name: "Storia" },
  ]);
  const file = (id: string, subjectId: string, title: string, texts: string[]) =>
    seedSource(db, {
      id,
      subjectId,
      title,
      document: { id: `d-${id}` },
      passages: texts.map((text, index) => ({ id: `${id}-p${index}`, text, section: `§${index + 1}` })),
    });
  file("src-fis", "s-fis", "Fisica 2, Mazzoldi", [
    "Il campo elettrico di un filo carico si trova con il teorema di Gauss su un cilindro.",
    "Per un filo carico infinito il campo elettrico è radiale e decresce come 1/r.",
    "Il flusso del campo elettrico attraverso il cilindro attorno al filo carico.",
  ]);
  file("src-an", "s-an", "Dispense di analisi", [
    "Il limite notevole di sin x su x vale uno quando x tende a zero.",
    "Una serie geometrica converge quando la ragione è minore di uno.",
  ]);
  file("src-sto", "s-sto", "Appunti di storia", ["Il Rinascimento nasce a Firenze.", "Le maree dipendono dalla Luna."]);
  return db;
}

async function openAsk(page: Page, path = "/ask") {
  await page.evaluate((hash) => {
    location.hash = hash;
  }, path);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Messaggio" })).toBeVisible();
}

async function ask(page: Page, text: string) {
  const box = page.getByRole("textbox", { name: "Messaggio" });
  await box.fill(text);
  await box.press("Enter");
  await expect(page).toHaveURL(/#\/ask\/.+/);
  await expect(page.getByRole("button", { name: "Interrompi" })).toHaveCount(0, { timeout: 60000 });
}

async function stored(page: Page) {
  return (await page.evaluate(() =>
    window.pyxis.invoke("chats.read", { chatId: location.hash.split("/").at(-1)! }),
  )) as {
    subject: string | null;
    subjectBy: string | null;
    sourceIds: string[];
    messages: Array<{ role: string; way: string; grounding: string | null }>;
  };
}

const chip = (page: Page) => page.getByRole("button", { name: /^Materia della chat|^Materia: sceglie|^Fonti della chat/ });
const lastReply = (page: Page) => page.locator(".px-msg:not(.px-msg-user):not(.px-msg-thinking)").last();

async function finish(app: ElectronApplication, userData: string, db?: DatabaseSync) {
  db?.close();
  await app.close();
  removeTestFolder(userData);
}

test("Ask: a new chat picks its subject from the Library, says what it used, and the chip corrects it", async () => {
  test.setTimeout(180000);
  const { app, page, userData } = await launch();
  const db = seedLibrary(userData);
  try {
    await openAsk(page);
    // No mode switch and no source or subject menus in the composer: only the plus, the whiteboard, the graph and Invia.
    await expect(page.getByRole("group", { name: "Modalità tutor" })).toHaveCount(0);
    await expect(page.locator(".px-composer").getByRole("button", { name: /Materia|Fonti|Risolutore|Socratico/ })).toHaveCount(0);
    for (const name of ["Aggiungi un file o una formula", "Lavagna", "Grafico", "Invia"])
      await expect(page.locator(".px-composer").getByRole("button", { name, exact: true })).toBeVisible();
    await expect(chip(page)).toHaveAccessibleName("Materia: sceglie Pyxis, dalle fonti che trova");
    await expect(chip(page)).toHaveText("Materia: sceglie Pyxis");

    await ask(page, "Campo elettrico di un filo carico");
    // Pyxis searched the whole Library and filed the chat under the subject its passages came from.
    await expect(chip(page)).toHaveText("Fisica 2");
    await expect(chip(page)).toHaveAccessibleName("Materia della chat: Fisica 2, scelta da Pyxis");
    expect(await stored(page)).toMatchObject({ subject: "Fisica 2", subjectBy: "pyxis" });

    // The answer says what it used, and the line opens the list of its passages.
    const used = lastReply(page).getByRole("button", { name: "Ho usato 1 fonte di Fisica 2" });
    await expect(used).toHaveAttribute("aria-expanded", "false");
    await used.click();
    await expect(used).toHaveAttribute("aria-expanded", "true");
    const list = lastReply(page).getByRole("list", { name: "Fonti usate" });
    await expect(list.getByRole("button")).toHaveText([/^1Fisica 2, Mazzoldi · §\d$/]);
    await saveShot(page, "ask-subject/picked.png");
    await expectNoAxeViolations(page);

    // The chip's menu: the subjects, then the whole Library, with the chat's subject checked.
    await atRest(chip(page));
    await chip(page).click();
    const menu = page.getByRole("region", { name: "Materia della chat" });
    await expect(menu.getByRole("menuitemradio")).toHaveText(["Analisi 1", "Fisica 2", "Storia", "Tutta la Libreria"]);
    await expect(menu.getByRole("menuitemradio", { name: "Fisica 2" })).toHaveAttribute("aria-checked", "true");
    await saveShot(page, "ask-subject/menu.png");
    await menu.getByRole("menuitemradio", { name: "Analisi 1" }).click();
    // The correction is the student's, said aloud, and the field takes the focus back.
    await expect(chip(page)).toHaveAccessibleName("Materia della chat: Analisi 1, scelta da te");
    await expect(page.getByRole("status").filter({ hasText: "Da ora in questa chat uso le fonti di Analisi 1." })).toHaveCount(1);
    await expect(page.getByRole("textbox", { name: "Messaggio" })).toBeFocused();

    // Analisi 1 has nothing on the wire: Pyxis looks in the rest of the Library and says so, and keeps the subject.
    await ask(page, "Teorema di Gauss per il filo carico");
    await expect(
      lastReply(page).getByRole("button", {
        name: "Nella materia della chat non c'era niente, quindi ho usato 1 fonte di Fisica 2",
      }),
    ).toBeVisible();
    expect(await stored(page)).toMatchObject({ subject: "Analisi 1", subjectBy: "student" });

    // The whole Library is a choice too, and it sticks.
    await atRest(chip(page));
    await chip(page).click();
    await page.getByRole("menuitemradio", { name: "Tutta la Libreria" }).click();
    await expect(chip(page)).toHaveText("Tutta la Libreria");
    await ask(page, "Campo elettrico di un filo carico");
    expect(await stored(page)).toMatchObject({ subject: null, subjectBy: "student" });
    await expect(chip(page)).toHaveText("Tutta la Libreria");
  } finally {
    await finish(app, userData, db);
  }
});

test("Ask: a subject renamed in the Library keeps its chats: the chip says the new name and the next question still searches it", async () => {
  test.setTimeout(180000);
  const { app, page, userData } = await launch();
  const db = seedLibrary(userData);
  try {
    await openAsk(page);
    await ask(page, "Campo elettrico di un filo carico");
    await expect(chip(page)).toHaveText("Fisica 2");
    const chatUrl = page.url();

    // Renamed in place on its shelf, by a double-click on its name.
    await toLibrary(page);
    await page.getByRole("region", { name: /^Fisica 2 \d+ file$/ }).getByRole("heading", { level: 2, name: "Fisica 2" }).dblclick();
    const field = page.getByRole("textbox", { name: "Nome della materia Fisica 2" });
    await field.fill("Fisica generale");
    await field.press("Enter");
    await expect(page.getByRole("region", { name: /^Fisica generale \d+ file$/ })).toBeVisible();

    // Back in the chat, the chip names the subject as it is now, still the one Pyxis picked.
    await page.getByRole("list", { name: "Chat" }).getByRole("link", { name: /^Campo elettrico/ }).click();
    await expect(page).toHaveURL(chatUrl);
    await expect(chip(page)).toHaveText("Fisica generale");
    await expect(chip(page)).toHaveAccessibleName("Materia della chat: Fisica generale, scelta da Pyxis");
    expect(await stored(page)).toMatchObject({ subject: "Fisica generale", subjectBy: "pyxis" });

    // A new question searches that subject's files: the answer says it used one of them and that nothing was missing.
    await ask(page, "Teorema di Gauss per il filo carico");
    await expect(lastReply(page).getByRole("button", { name: "Ho usato 1 fonte di Fisica generale" })).toBeVisible();
    expect((await stored(page)).messages.at(-1)).toMatchObject({ grounding: "sources" });
    await expect(chip(page)).toHaveText("Fisica generale");
  } finally {
    await finish(app, userData, db);
  }
});

test("Ask: the subject can be chosen on a new chat's first page, from the keyboard, and goes with the first question", async () => {
  test.setTimeout(150000);
  const { app, page, userData } = await launch();
  const db = seedLibrary(userData);
  try {
    await openAsk(page);
    await chip(page).focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("region", { name: "Materia della chat" });
    // A new chat can go back to letting Pyxis pick, which is the choice until the student makes one.
    await expect(menu.getByRole("menuitemradio")).toHaveText([
      "Lascia scegliere a Pyxis",
      "Analisi 1",
      "Fisica 2",
      "Storia",
      "Tutta la Libreria",
    ]);
    await expect(menu.getByRole("menuitemradio", { name: "Lascia scegliere a Pyxis" })).toHaveAttribute("aria-checked", "true");
    await saveShot(page, "ask-subject/first-page-menu.png");
    // Escape closes it and gives the focus back to the chip.
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(chip(page)).toBeFocused();
    // A slow computer can take the first arrow before the menu exists, let alone has the focus: it is the menu's all the
    // same. The click and the key go in one task here, so the arrow always comes first.
    await chip(page).evaluate((button) => {
      (button as HTMLElement).click();
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    await expect(menu.getByRole("menuitemradio", { name: "Lascia scegliere a Pyxis" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(chip(page)).toBeFocused();
    await page.keyboard.press("Enter");
    for (const name of ["Lascia scegliere a Pyxis", "Analisi 1", "Fisica 2"]) {
      await page.keyboard.press("ArrowDown");
      await expect(menu.getByRole("menuitemradio", { name })).toBeFocused();
    }
    await page.keyboard.press("Enter");
    await expect(chip(page)).toHaveAccessibleName("Materia della chat: Fisica 2, scelta da te");
    await expect(page.getByRole("textbox", { name: "Messaggio" })).toBeFocused();

    await ask(page, "Campo elettrico di un filo carico");
    expect(await stored(page)).toMatchObject({ subject: "Fisica 2", subjectBy: "student" });
    await expect(chip(page)).toHaveAccessibleName("Materia della chat: Fisica 2, scelta da te");

    // The next new chat starts again with Pyxis's choice.
    await page.getByRole("link", { name: "Nuova chat" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(chip(page)).toHaveText("Materia: sceglie Pyxis");
  } finally {
    await finish(app, userData, db);
  }
});

test("Ask: a subject chosen on a new chat's first page survives the whiteboard, the Library, a reload and a renamed subject, and goes with the first question", async () => {
  test.setTimeout(180000);
  const { app, page, userData } = await launch();
  const db = seedLibrary(userData);
  try {
    await openAsk(page);
    await atRest(chip(page));
    await chip(page).click();
    await page.getByRole("menuitemradio", { name: "Fisica 2" }).click();
    await expect(chip(page)).toHaveAccessibleName("Materia della chat: Fisica 2, scelta da te");

    // The whiteboard: draw, attach the drawing, and come back to the new chat with the subject still chosen.
    await page.locator(".px-composer").getByRole("button", { name: "Lavagna", exact: true }).click();
    await expect(page).toHaveURL(/#\/tools\/whiteboard$/);
    const canvas = page.locator(".px-whiteboard canvas");
    await expect(canvas).toBeVisible();
    const rect = (await canvas.boundingBox())!;
    await page.mouse.move(rect.x + 100, rect.y + 200);
    await page.mouse.down();
    await page.mouse.move(rect.x + 250, rect.y + 300, { steps: 12 });
    await page.mouse.up();
    await page.getByRole("button", { name: "Allega alla chat" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(page.getByAltText("Lavagna")).toBeVisible();
    await expect(chip(page)).toHaveAccessibleName("Materia della chat: Fisica 2, scelta da te");

    // A reload keeps it, like the draft.
    await page.reload();
    await expect(chip(page)).toHaveAccessibleName("Materia della chat: Fisica 2, scelta da te");

    // The subject is renamed in the Library meanwhile: the choice follows it.
    await toLibrary(page);
    await page.getByRole("region", { name: /^Fisica 2 \d+ file$/ }).getByRole("heading", { level: 2, name: "Fisica 2" }).dblclick();
    const field = page.getByRole("textbox", { name: "Nome della materia Fisica 2" });
    await field.fill("Fisica generale");
    await field.press("Enter");
    await expect(page.getByRole("region", { name: /^Fisica generale \d+ file$/ })).toBeVisible();
    await page.getByRole("link", { name: "Nuova chat" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(chip(page)).toHaveAccessibleName("Materia della chat: Fisica generale, scelta da te");

    // The first question goes with it (the drawing leaves, as reading a photo needs data this test does not download),
    // and the next new chat starts with Pyxis's choice again.
    await page.getByRole("button", { name: /^Rimuovi .*\.png$/ }).click();
    await ask(page, "Campo elettrico di un filo carico");
    expect(await stored(page)).toMatchObject({ subject: "Fisica generale", subjectBy: "student" });
    await page.getByRole("link", { name: "Nuova chat" }).click();
    await expect(chip(page)).toHaveText("Materia: sceglie Pyxis");
    await page.reload();
    await expect(chip(page)).toHaveText("Materia: sceglie Pyxis");
  } finally {
    await finish(app, userData, db);
  }
});

test("Ask: the action under an answer asks again the other way, in both directions, and keeps it after a reload", async () => {
  test.setTimeout(180000);
  const { app, page, userData } = await launch({ PYXIS_E2E_REPLY: REPLY, PYXIS_E2E_REPLY_DELAY: "2500" });
  const db = seedLibrary(userData);
  try {
    await openAsk(page);
    await ask(page, "Calcola il campo elettrico a 5 cm da un filo carico");
    // A question that asks for the result is solved, so the action under it offers a guide.
    const guide = lastReply(page).getByRole("button", { name: "Guidami passo passo" });
    await expect(guide).toBeVisible();
    expect((await stored(page)).messages.at(-1)).toMatchObject({ way: "solved" });
    await guide.click();
    // The answer is rewritten in place, with a working line that says how, and no action until it is done.
    await expect(page.getByRole("status").filter({ hasText: "Riscrivo la risposta un passo alla volta" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Guidami passo passo" })).toHaveCount(0);
    await saveShot(page, "ask-subject/switching.png");
    const solve = lastReply(page).getByRole("button", { name: "Dammi la soluzione" });
    await expect(solve).toBeVisible({ timeout: 60000 });
    await expect(page.locator(".px-msg:not(.px-msg-user):not(.px-msg-thinking)")).toHaveCount(1);
    expect((await stored(page)).messages.at(-1)).toMatchObject({ way: "guided" });

    // After a reload the answer still offers the way it did not take.
    await page.reload();
    await expect(lastReply(page).getByRole("button", { name: "Dammi la soluzione" })).toBeVisible();
    await lastReply(page).getByRole("button", { name: "Dammi la soluzione" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Scrivo la soluzione completa" })).toBeVisible();
    await expect(lastReply(page).getByRole("button", { name: "Guidami passo passo" })).toBeVisible({ timeout: 60000 });
    expect((await stored(page)).messages.at(-1)).toMatchObject({ way: "solved" });

    // A question that asks for help is guided from the start, and only the last answer carries the action.
    await ask(page, "Non ho capito, mi aiuti a ragionarci?");
    expect((await stored(page)).messages.at(-1)).toMatchObject({ way: "guided" });
    await expect(page.getByRole("button", { name: "Dammi la soluzione" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Guidami passo passo" })).toHaveCount(0);
  } finally {
    await finish(app, userData, db);
  }
});

test("Ask: an answer with nothing in the Library says it comes from general knowledge, and the chip waits", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  const db = seedLibrary(userData);
  try {
    await openAsk(page);
    await ask(page, "Ricetta della carbonara");
    await expect(
      lastReply(page).getByText(
        "Non ho trovato niente su questa domanda nella tua Libreria, quindi ti rispondo con quello che so in generale.",
      ),
    ).toBeVisible();
    await expect(lastReply(page).getByRole("button", { name: /^Ho usato/ })).toHaveCount(0);
    await expect(chip(page)).toHaveText("Materia: sceglie Pyxis");
    expect(await stored(page)).toMatchObject({ subject: null, subjectBy: null });
    await saveShot(page, "ask-subject/general.png");
    await expectNoAxeViolations(page);
  } finally {
    await finish(app, userData, db);
  }
});

test("Ask: an older chat with sources picked by hand keeps them and shows it, and a subject from the chip replaces them", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  const db = seedLibrary(userData);
  try {
    db.exec(`
      INSERT INTO chats(id,title,scope_json,created_at,updated_at) VALUES ('c-old','Serie e limiti','["src-an"]',1,1);
      INSERT INTO messages(id,chat_id,role,body,created_at) VALUES ('m-old','c-old','user','Che cos''è una serie?',1);
      INSERT INTO messages(id,chat_id,role,body,grounding,prompt_template,created_at) VALUES ('r-old','c-old','assistant','Una somma infinita.','sources','chat.solver',2);
    `);
    await openAsk(page, "/ask/c-old");
    await expect(chip(page)).toHaveText("1 fonte scelta");
    await expect(chip(page)).toHaveAccessibleName("Fonti della chat: 1 fonte scelta a mano");
    // It keeps answering from that source: the wire is not in it, so Pyxis neither cites Fisica 2 nor picks a subject.
    await ask(page, "Campo elettrico di un filo carico");
    expect(await stored(page)).toMatchObject({ subject: null, sourceIds: ["src-an"] });
    await expect(chip(page)).toHaveText("1 fonte scelta");

    await atRest(chip(page));
    await chip(page).click();
    const menu = page.getByRole("region", { name: "Materia della chat" });
    await expect(menu.getByRole("menuitemradio", { name: "La fonte scelta a mano" })).toHaveAttribute("aria-checked", "true");
    await menu.getByRole("menuitemradio", { name: "Fisica 2" }).click();
    await expect(chip(page)).toHaveText("Fisica 2");
    expect(await stored(page)).toMatchObject({ subject: "Fisica 2", subjectBy: "student", sourceIds: [] });
  } finally {
    await finish(app, userData, db);
  }
});

test("Ask: a chat opened from an exam with no subject says it is that exam, not a chosen source, and a subject from the chip replaces it", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  const db = seedLibrary(userData);
  try {
    seedPlan(db, { id: "p-exam", title: "Analisi, scritto di luglio", sourceIds: ["src-an"] });
    db.exec(`
      INSERT INTO chats(id,title,scope_json,created_at,updated_at) VALUES ('c-exam','Limiti','{"planId":"p-exam","sourceIds":[]}',1,1);
      INSERT INTO messages(id,chat_id,role,body,created_at) VALUES ('m-exam','c-exam','user','Che cos''è un limite?',1);
    `);
    await openAsk(page, "/ask/c-exam");
    await expect(chip(page)).toHaveText("Esame: Analisi, scritto di luglio");
    await expect(chip(page)).toHaveAccessibleName("Fonti della chat: i file dell'esame Analisi, scritto di luglio");
    await atRest(chip(page));
    await chip(page).click();
    const menu = page.getByRole("region", { name: "Materia della chat" });
    await expect(menu.getByRole("menuitemradio", { name: "I file dell'esame Analisi, scritto di luglio" })).toHaveAttribute("aria-checked", "true");
    await saveShot(page, "ask-subject/exam-menu.png");
    await menu.getByRole("menuitemradio", { name: "Analisi 1" }).click();
    await expect(chip(page)).toHaveText("Analisi 1");
  } finally {
    await finish(app, userData, db);
  }
});

test("Ask: an answer that cites no source says so when passages were found, and where Pyxis looked when nothing was", async () => {
  test.setTimeout(150000);
  // The recorded engine answers without a citation, so the passages the search finds are left unused.
  const { app, page, userData } = await launch({ PYXIS_E2E_REPLY: "Il campo è radiale, senza citare niente." });
  const db = seedLibrary(userData);
  try {
    await openAsk(page);
    await ask(page, "Campo elettrico di un filo carico");
    await expect(
      lastReply(page).getByText("Nelle tue fonti ho trovato qualcosa, ma questa risposta non ne cita nessuna, quindi viene da quello che so in generale."),
    ).toBeVisible();
    await expect(page.getByText("Non ho trovato niente su questa domanda")).toHaveCount(0);
    await saveShot(page, "ask-subject/general-unused.png");
    await expectNoAxeViolations(page);
    // The saved reply says the same after a reload.
    await page.reload();
    await expect(lastReply(page).getByText(/^Nelle tue fonti ho trovato qualcosa/)).toBeVisible();

    // A chat limited to files picked by hand says it looked there, not in the whole Library.
    db.exec(`
      INSERT INTO chats(id,title,scope_json,created_at,updated_at) VALUES ('c-old','Serie e limiti','["src-an"]',1,1);
      INSERT INTO messages(id,chat_id,role,body,created_at) VALUES ('m-old','c-old','user','Che cos''è una serie?',1);
    `);
    await openAsk(page, "/ask/c-old");
    await ask(page, "Campo elettrico di un filo carico");
    await expect(
      lastReply(page).getByText("Non ho trovato niente su questa domanda nei file di questa chat, quindi ti rispondo con quello che so in generale."),
    ).toBeVisible();
  } finally {
    await finish(app, userData, db);
  }
});

test("Ask: with an empty Library there is no chip, and without an AI tool the question fails in place with nothing changed", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch({});
  try {
    await openAsk(page);
    await expect(chip(page)).toHaveCount(0);
    const db = seedLibrary(userData);
    db.close();
    await openAsk(page);
    await expect(chip(page)).toHaveText("Materia: sceglie Pyxis");
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Campo elettrico di un filo carico");
    await box.press("Enter");
    // The question goes back to the field with the error under it; no chat was made and the chip is as it was.
    await expect(page.locator(".ask-dock .px-notice")).toBeVisible({ timeout: 30000 });
    await expect(box).toHaveText("Campo elettrico di un filo carico");
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(chip(page)).toHaveText("Materia: sceglie Pyxis");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
