import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis, setUp } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { saveShot } from "./shots";

/*
 * The chat's "ask first" tools. The recorded engine calls each proposal tool through the app's own MCP server, as a CLI
 * would; the card, the decision through `chats.decideTool` and the change the app makes all run for real. Each test
 * checks what the student's yes changed in the workspace, and that nothing changed before it.
 */

const NEXT = new Date().getFullYear() + 1;
const day = (month: number, date: number) => new Date(NEXT, month - 1, date, 12).getTime();
const TOPICS = ["Cinematica", "Dinamica", "Lavoro ed energia", "Fluidi", "Termodinamica", "Oscillazioni"];

function seed(userData: string) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  try {
    seedSubjects(db, [
      { id: "phys", name: "Fisica 1" },
      { id: "chem", name: "Chimica generale" },
    ]);
    seedPlan(db, { id: "p-phys", subjectId: "phys", title: "Fisica 1", topics: TOPICS.map((title, i) => ({ id: `t${i}`, title })) });
    db.prepare("INSERT INTO plan_sessions (id, plan_id, date, time, place, label, created_at) VALUES ('s1', 'p-phys', ?, NULL, NULL, 'Scritto', 1)").run(day(1, 22));
    db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('planner', ?, 1)").run(JSON.stringify({ weeklyHours: 6, weeks: {} }));
    // Flashcards of Cinematica: three Pyxis made, one of them reviewed, and one the student wrote.
    const card = db.prepare("INSERT INTO cards (id, plan_id, topic_id, front, back, seed_key, created_at) VALUES (?, 'p-phys', 't0', ?, 'Risposta', ?, 1)");
    card.run("c1", "Che cos'è la velocità media?", "a");
    card.run("c2", "Che cos'è l'accelerazione?", "b");
    card.run("c3", "Come si legge un grafico s-t?", "c");
    card.run("mine", "La mia flashcard", null);
    db.prepare("INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at) VALUES ('r1', 'c1', 'good', '{}', 5)").run();
    seedSource(db, { id: "disp", title: "Dispense di Chimica 2026", subjectId: "chem", document: { id: "disp-doc" }, passages: [{ id: "pc1", text: "La struttura atomica.", section: "Atomi" }] });
    const chat = db.prepare("INSERT INTO chats (id, title, subject, scope_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 2)");
    chat.run("path-chat", "Esame anticipato", "Fisica 1", JSON.stringify({ planId: "p-phys", ids: [], subjectBy: "student" }));
    chat.run("exam-chat", "Un esame di Chimica", "Fisica 1", JSON.stringify({ planId: null, ids: [], subjectBy: "student" }));
  } finally {
    db.close();
  }
}

function query<T>(userData: string, sql: string): T[] {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

/** The student's results and history, whole: no proposal and no decision may change them. */
const record = (userData: string) =>
  ["attempts", "attempt_answers", "card_reviews", "learning_events", "gaps"].map((table) => query(userData, `SELECT * FROM ${table} ORDER BY 1`));

const activeTopics = (userData: string) =>
  query<{ title: string }>(userData, "SELECT title FROM topics WHERE plan_id = 'p-phys' AND archived_at IS NULL ORDER BY position").map((row) => row.title);

const openChat = async (page: Page, id: string) => {
  await page.evaluate((chat) => {
    location.hash = `/ask/${chat}`;
  }, id);
  await expect(page.getByRole("textbox", { name: "Messaggio" })).toBeVisible();
};

async function ask(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Messaggio" }).fill(text);
  await page.keyboard.press("Enter");
}

async function shots(page: Page, name: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
    await saveShot(page, `chat-proposals/${name}-${theme}.png`, { animations: "disabled" });
  }
  await page.evaluate(() => window.pyxis.setAppearance("light"));
}

async function start(userData: string, env: Record<string, string>) {
  let app: ElectronApplication;
  try {
    app = await launchPyxis({ userData, env });
  } catch (error) {
    removeTestFolder(userData);
    throw error;
  }
  const page = await setUp(app, userData, async () => {
    const first = await app.firstWindow();
    await first.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(first);
    seed(userData);
    await first.evaluate(() => window.pyxis.setAppearance("light"));
    await first.reload();
    return first;
  });
  return { app, page };
}

const PATH_ARGS = {
  exam_date: `${NEXT}-01-15`,
  weekly_hours: 8,
  remove_topics: ["Fluidi"],
  move_topics: [{ title: "Oscillazioni", after: "Dinamica" }],
  add_topics: [{ title: "Urti e quantità di moto", after: "Lavoro ed energia" }],
};

test("a change to the path waits for Applica: refused, reviewed, applied, after a restart and in the export", async () => {
  test.setTimeout(300000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-propose-path-"));
  const env = {
    PYXIS_E2E_REPLY: [
      "Ho preparato le modifiche al percorso di Fisica 1.",
      `@@tool propose_path_change ${JSON.stringify(PATH_ARGS)}`,
      "Non ho ancora cambiato niente: guarda se è come ti serve.",
    ].join("\n"),
    PYXIS_E2E_REPLY_DELAY: "4000",
  };
  let { app, page } = await start(userData, env);
  try {
    const before = record(userData);
    await openChat(page, "path-chat");
    await ask(page, "Il prof ha anticipato l'esame al 15 gennaio. Mi sistemi il percorso?");
    const answer = page.locator(".px-msg:not(.px-msg-user)").last();
    const card = answer.getByRole("region", { name: "Da confermare: Cambiare il percorso di Fisica 1" });
    // While the reply is still written the card is there, and its buttons wait for it.
    await expect(card).toBeVisible({ timeout: 30000 });
    await expect(card.getByText("Pronta quando la risposta è finita.")).toBeVisible();
    await expect(card.getByRole("button", { name: "Applica" })).toBeDisabled();
    // Saved: the safe choice has the focus, Applica is the primary and Invia is quiet.
    await expect(page.getByRole("button", { name: "Interrompi", exact: true })).toHaveCount(0, { timeout: 30000 });
    const saved = page.locator(".px-msg:not(.px-msg-user)").last().getByRole("region", { name: /^Da confermare/ });
    await expect(saved.getByRole("button", { name: "Non cambiare" })).toBeFocused();
    await expect(saved.getByRole("button", { name: "Applica" })).toHaveClass(/px-btn-primary/);
    await expect(page.getByRole("button", { name: "Invia" })).toHaveClass(/px-btn-secondary/);
    // The weekday follows the year the test runs in, so only the day and month are checked.
    await expect(saved.getByText(/22 gennaio/)).toBeVisible();
    await expect(saved.getByText("vale per tutti i tuoi esami")).toBeVisible();
    await expect(saved.locator("li.is-removed")).toHaveText(["FluidiTolto"]);
    await expect(saved.locator("li.is-moved")).toHaveText(["OscillazioniSpostato, era 6°"]);
    await expect(saved.locator("li.is-added")).toHaveText(["Urti e quantità di motoAggiunto"]);
    expect(activeTopics(userData)).toEqual(TOPICS);
    await shots(page, "path-pending");

    // «Non cambiare»: nothing changed, and the line says so, with the way back to the proposal.
    await saved.getByRole("button", { name: "Non cambiare" }).click();
    const reply = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(reply.getByText("Non ho cambiato niente: il percorso è quello di prima.")).toBeVisible();
    await expect(reply.getByRole("button", { name: "Rivedi la proposta" })).toBeFocused();
    await expect(page.getByRole("button", { name: "Invia" })).toHaveClass(/px-btn-primary/);
    expect(activeTopics(userData)).toEqual(TOPICS);
    await shots(page, "path-declined");
    await reply.getByRole("button", { name: "Rivedi la proposta" }).click();
    // Reopened, the card waits again with the focus on its safe choice.
    await expect(reply.getByRole("button", { name: "Non cambiare" })).toBeFocused();
    await reply.getByRole("button", { name: "Applica" }).click();
    await expect(reply.getByText(/^Percorso aggiornato: esame il 15 gennaio( \d{4})?, 8 ore a settimana, 3 argomenti cambiati\.$/)).toBeVisible();
    await expect(reply.getByRole("button", { name: "Apri il percorso" })).toBeFocused();
    expect(activeTopics(userData)).toEqual(["Cinematica", "Dinamica", "Oscillazioni", "Lavoro ed energia", "Urti e quantità di moto", "Termodinamica"]);
    expect(query<{ date: number; label: string }>(userData, "SELECT date, label FROM plan_sessions WHERE plan_id = 'p-phys'")).toEqual([{ date: day(1, 15), label: "Scritto" }]);
    expect(JSON.parse(query<{ value_json: string }>(userData, "SELECT value_json FROM settings WHERE key = 'planner'")[0]!.value_json).weeklyHours).toBe(8);
    expect(record(userData)).toEqual(before);
    await shots(page, "path-applied");

    // The export writes one line for it.
    const exported = await page.evaluate(() => window.pyxis.invoke("chats.export", { chatId: "path-chat", language: "it" }));
    expect(exported.markdown).toMatch(/\*Pyxis ha proposto di cambiare il percorso di Fisica 1: hai applicato la modifica \(esame il 15 gennaio \d{4}, 8 ore a settimana, 3 argomenti cambiati\)\.\*/);
    await app.close();

    // After a restart the line is still there, and «Apri il percorso» opens the exam.
    app = await launchPyxis({ userData, env });
    page = await app.firstWindow();
    await openChat(page, "path-chat");
    await expect(page.getByText(/^Percorso aggiornato: esame il 15 gennaio/)).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: "Apri il percorso" }).click();
    await expect(page).toHaveURL(/#\/plans\/p-phys/);
  } finally {
    await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});

test("a proposal whose path changed is not applied, a pending one lapses on a regenerate, and one waits across a restart", async () => {
  test.setTimeout(300000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-propose-stale-"));
  const env = {
    PYXIS_E2E_REPLY: ["Ecco la proposta.", `@@tool propose_path_change ${JSON.stringify({ remove_topics: ["Termodinamica"] })}`, "Dimmi tu."].join("\n"),
  };
  let { app, page } = await start(userData, env);
  try {
    await openChat(page, "path-chat");
    await ask(page, "Togli Termodinamica dal percorso.");
    const card = () => page.locator(".px-msg:not(.px-msg-user)").last().getByRole("region", { name: /^Da confermare/ });
    await expect(card().getByRole("button", { name: "Applica" })).toBeEnabled({ timeout: 30000 });
    await app.close();

    // A pending proposal waits across a restart, as it was.
    app = await launchPyxis({ userData, env });
    page = await app.firstWindow();
    await openChat(page, "path-chat");
    await expect(card().getByRole("button", { name: "Applica" })).toBeEnabled({ timeout: 30000 });

    // «Rigenera» takes the pending proposal with its reply; the new answer proposes again, as a new result.
    const results = () => query<{ id: string }>(userData, "SELECT id FROM chat_tool_results").map((row) => row.id);
    const [original] = results();
    await page.getByRole("button", { name: "Rigenera" }).last().click();
    await expect(page.getByRole("button", { name: "Interrompi", exact: true })).toHaveCount(0, { timeout: 30000 });
    await expect(page.getByRole("region", { name: /^Da confermare/ })).toHaveCount(1);
    await expect.poll(results).toEqual([expect.not.stringMatching(original!)]);

    // The exam is renamed in its settings before Applica: nothing is applied, and the line says why.
    await page.evaluate(() =>
      window.pyxis.invoke("plans.settings", { planId: "p-phys", title: "Fisica I", target: 0.75, sessions: [] }),
    );
    await card().getByRole("button", { name: "Applica" }).click();
    const reply = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(reply.getByText("Il percorso è cambiato nel frattempo, quindi non ho applicato niente.")).toBeVisible();
    await expect(reply.getByRole("button", { name: "Chiedi di nuovo" })).toBeVisible();
    expect(activeTopics(userData)).toEqual(TOPICS);
    await shots(page, "path-stale");
    // «Chiedi di nuovo» asks in the chat, and the new answer proposes on the path as it is now.
    await reply.getByRole("button", { name: "Chiedi di nuovo" }).click();
    await expect(page.getByText("Il percorso è cambiato: rifammi la proposta.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Interrompi", exact: true })).toHaveCount(0, { timeout: 30000 });
    await expect(page.getByText("Questa proposta è stata sostituita da una più recente: non cambia niente.")).toBeVisible();
    await expect(card().getByRole("button", { name: "Applica" })).toBeEnabled();
    await shots(page, "path-expired-and-new");
  } finally {
    await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});

test("a new exam is a draft until «Crea l'esame», which starts its build; «Modifica prima» opens the form filled in", async () => {
  test.setTimeout(300000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-propose-exam-"));
  const hold = join(userData, "build-go");
  const env = {
    PYXIS_E2E_REPLY: [
      "Posso crearlo così.",
      `@@tool propose_exam ${JSON.stringify({ title: "Chimica generale", exam_date: `${NEXT}-02-09` })}`,
      "Finché non confermi, tra i tuoi esami non c'è niente di nuovo.",
    ].join("\n"),
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({
      topics: { hold, topics: [{ title: "Atomi", summary: "Struttura atomica", subtopics: ["Struttura"], segmentIds: ["{{segment:0}}"] }] },
      markdown: { markdown: "## Atomi\n\nStudierai la struttura atomica [P1]." },
      questions: {
        questions: Array.from({ length: 10 }, (_, i) => ({
          stem: `Domanda ${i + 1} sugli atomi?`,
          options: ["Protoni", "Calore", "Massa", "Volume"],
          correct: 0,
          topicIndex: 0,
          passageIds: ["{{passage:0}}"],
          explanation: "Gli atomi hanno protoni.",
        })),
      },
    }),
  };
  const { app, page } = await start(userData, env);
  try {
    await openChat(page, "exam-chat");
    await ask(page, "A febbraio ho Chimica generale, lo scritto è lunedì 9. Me lo prepari?");
    const card = page.locator(".px-msg:not(.px-msg-user)").last().getByRole("region", { name: "Da confermare: Nuovo esame: Chimica generale" });
    await expect(card.getByRole("button", { name: "Crea l'esame" })).toBeEnabled({ timeout: 30000 });
    await expect(card.getByRole("button", { name: "Non creare" })).toBeFocused();
    await expect(card.getByText("Dispense di Chimica 2026, dalla tua Libreria")).toBeVisible();
    expect(query(userData, "SELECT id FROM plans WHERE title = 'Chimica generale'")).toEqual([]);
    await shots(page, "exam-pending");

    // «Modifica prima» opens the exam form with the draft's name, subject and date.
    await card.getByRole("button", { name: "Modifica prima" }).click();
    await expect(page).toHaveURL(/#\/plans\/new/);
    await expect(page.locator("#plan-title")).toHaveValue("Chimica generale");
    await page.goBack();
    await expect(page.getByRole("region", { name: /^Da confermare/ })).toBeVisible();

    await page.getByRole("region", { name: /^Da confermare/ }).getByRole("button", { name: "Crea l'esame" }).click();
    const reply = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(reply.getByText(/^Esame creato: Chimica generale, \S+ 9 febbraio/)).toBeVisible();
    await expect(reply.getByText("Preparo il percorso…")).toBeVisible();
    const plan = query<{ id: string; status: string }>(userData, "SELECT id, status FROM plans WHERE title = 'Chimica generale'");
    expect(plan).toHaveLength(1);
    expect(query(userData, `SELECT source_id FROM plan_sources WHERE plan_id = '${plan[0]!.id}'`)).toEqual([{ source_id: "disp" }]);
    await shots(page, "exam-building");
    writeFileSync(hold, "");
    // The build ends with the exam ready, not only with the working line gone.
    await expect
      .poll(() => query<{ status: string }>(userData, `SELECT status FROM plans WHERE id = '${plan[0]!.id}'`)[0]!.status, { timeout: 60000 })
      .toBe("ready");
    await expect(reply.getByText("Preparo il percorso…")).toHaveCount(0, { timeout: 60000 });
    await shots(page, "exam-created");
    await reply.getByRole("button", { name: "Apri l'esame" }).click();
    await expect(page).toHaveURL(new RegExp(`#/plans/${plan[0]!.id}`));
  } finally {
    await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});

test("a deletion starts on «Non eliminare», deletes only Pyxis's cards with their reviews kept, and «Annulla» brings them back", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-propose-delete-"));
  const env = {
    PYXIS_E2E_REPLY: ["Prima di eliminarle ti dico cosa perdi.", `@@tool propose_delete ${JSON.stringify({ kind: "flashcards", topic: "Cinematica" })}`].join("\n"),
  };
  const { app, page } = await start(userData, env);
  try {
    const before = record(userData);
    await openChat(page, "path-chat");
    await ask(page, "Le flashcard di Cinematica sono fatte male, eliminale.");
    const card = page.locator(".px-msg:not(.px-msg-user)").last().getByRole("region", { name: "Da confermare: Eliminare 3 flashcard di Cinematica?" });
    await expect(card.getByRole("button", { name: "Non eliminare" })).toBeFocused({ timeout: 30000 });
    await expect(card.getByText(/1 l'hai già ripassata almeno una volta.*La flashcard che hai scritto tu resta\..*«Annulla» le rimette nel mazzo\./)).toBeVisible();
    await shots(page, "delete-pending");
    // Tab reaches the confirming button.
    await page.keyboard.press("Tab");
    await expect(card.getByRole("button", { name: "Elimina 3 flashcard" })).toBeFocused();
    await page.keyboard.press("Enter");
    const reply = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(reply.getByText("3 flashcard di Cinematica eliminate.")).toBeVisible();
    expect(query(userData, "SELECT id FROM cards WHERE removed = 1 ORDER BY id")).toEqual([{ id: "c1" }, { id: "c2" }, { id: "c3" }]);
    expect(record(userData)).toEqual(before);
    await shots(page, "delete-done");
    await reply.getByRole("button", { name: "Annulla" }).click();
    await expect(reply.getByText("Eliminazione annullata: le flashcard sono di nuovo nel mazzo.")).toBeVisible();
    await shots(page, "delete-restored");
    expect(query(userData, "SELECT id FROM cards WHERE removed = 1")).toEqual([]);
    expect(record(userData)).toEqual(before);
  } finally {
    await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});
