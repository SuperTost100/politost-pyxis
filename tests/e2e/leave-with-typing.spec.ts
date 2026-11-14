import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedPlan, seedSource } from "./seed";

/**
 * An answer typed into the exercises page lives only in the window, so every way out of the page asks "Uscire senza
 * salvare?" before it drops it: the bar's back control and its Fai il quiz tool, a link in the Attività panel, the menu's Indietro, the mouse's
 * side button and the swipe. Without an answer typed, they leave at once.
 */

const practice = /#\/plans\/p-ex\/practice\/t-ex$/;

async function pick(app: ElectronApplication, id: string) {
  const found = await app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    item?.click();
    return Boolean(item);
  }, id);
  expect(found, `menu item ${id}`).toBe(true);
}

test("an answer typed on the exercises page is asked about by every way out, and nothing asks without one", async () => {
  test.setTimeout(90_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-leave-typing-"));
  const app = await launchPyxis({ userData });
  try {
    const page: Page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    try {
      seedSource(db, {
        id: "src-ex",
        title: "Appunti di fisica",
        document: { id: "doc-ex" },
        passages: [{ id: "ps-ex", text: "La forza è massa per accelerazione.", locator: { chapter: 1, paragraph: "p1" }, section: "1. Dinamica" }],
      });
      seedPlan(db, { id: "p-ex", title: "Fisica 1", language: "it", target: 0.75, sourceIds: ["src-ex"], topics: [{ id: "t-ex", title: "Dinamica" }] });
      db.exec(`INSERT INTO topic_passages(topic_id,passage_id) VALUES('t-ex','ps-ex');
        INSERT INTO smartbooks(id,source_id,meta_json,created_at) VALUES('b-ex','src-ex','{"title":"Fisica","chapters":[]}',1);
        INSERT INTO exercises(id,smartbook_id,passage_id,prompt,answer,locator_json,grounding,created_at)
          VALUES('x-ex','b-ex','ps-ex','Calcola la forza per m=2 kg e a=3 m/s2.','F=ma=6 N','{"chapter":1,"kind":"esame"}','sources',1);`);
      // A job that failed for want of an AI tool: its card in Attività has a link that leaves the page.
      db.prepare(
        "INSERT INTO jobs(id,kind,params_json,state,progress,error,created_at,updated_at) VALUES('j-fail','lesson-part',?,'failed',0,'engines.errors.engine-missing',?,?)",
      ).run(JSON.stringify({ planId: "p-ex", topicId: "t-ex", position: 1 }), Date.now(), Date.now());
    } finally {
      db.close();
    }
    await page.reload();
    await page.evaluate(() => {
      location.hash = "/plans/p-ex";
    });
    await expect(page.getByRole("heading", { level: 1, name: "Fisica 1" })).toBeVisible();
    // The exercises page, opened from the exam, so it has a page behind it to go back to.
    await page.evaluate(() => {
      location.hash = "/plans/p-ex/practice/t-ex";
    });
    const answer = page.getByRole("textbox", { name: "La tua risposta" });
    await expect(answer).toBeVisible();
    await answer.click();
    await page.keyboard.type("F = 6 N");
    await expect(answer).toContainText("F = 6 N");

    const swipe = () =>
      app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.emit("swipe", {}, "left");
      });
    const mouse = () =>
      page.evaluate(() => window.dispatchEvent(new MouseEvent("mouseup", { button: 3, bubbles: true, cancelable: true })));
    const control = () => page.getByRole("button", { name: "Torna a Fisica 1" });
    const leave = page.getByRole("dialog", { name: "Uscire senza salvare?" });
    const ways = [
      () => pick(app, "back"),
      swipe,
      mouse,
      () => control().click(),
      // The bar's own tool, and a link in the Attività panel: both leave the page like the back control.
      () => page.getByRole("banner").getByRole("button", { name: "Fai il quiz" }).click(),
      async () => {
        await page.getByRole("banner").getByRole("button", { name: /^Attività/ }).click();
        await page.getByRole("button", { name: "Vai agli strumenti AI" }).click();
      },
    ];
    // The foot's Indietro and Torna al percorso are gone: the bar's control is the one way back.
    await expect(page.getByRole("button", { name: "Indietro", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Torna al percorso", exact: true })).toHaveCount(0);
    for (const way of ways) {
      await way();
      // The question comes with what would be lost, and staying keeps the page and the answer as they were.
      await expect(leave).toBeVisible();
      await expect(leave).toContainText("La risposta che hai scritto andrà persa.");
      await leave.getByRole("button", { name: "Resta qui" }).click();
      await expect(leave).toHaveCount(0);
      await expect(page).toHaveURL(practice);
      await expect(answer).toContainText("F = 6 N");
    }
    // Leaving drops the answer and goes where the control said.
    await control().click();
    await leave.getByRole("button", { name: "Esci senza salvare" }).click();
    await expect(page).toHaveURL(/#\/plans\/p-ex$/);

    // With nothing typed, and with an answer wiped out again, nothing asks.
    await page.evaluate(() => {
      location.hash = "/plans/p-ex/practice/t-ex";
    });
    await expect(answer).toBeVisible();
    await answer.click();
    await page.keyboard.type("x");
    await page.keyboard.press("Backspace");
    await control().click();
    await expect(page).toHaveURL(/#\/plans\/p-ex$/);
    await expect(leave).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/**
 * The new exam and the guided exam hold answers that live only in the window: every way out asks before dropping them,
 * and asks nothing while they are empty. The guided exam hands its answers back to the new exam, and the wait while an
 * exam builds asks nothing, since the build goes on in Attività.
 */
test("a half-filled new exam and a guided exam are asked about by every way out, and the build wait is not", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-leave-wizard-"));
  const app = await launchPyxis({ userData });
  try {
    const page: Page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    try {
      seedPlan(db, { id: "p-build", title: "Chimica", status: "building", language: "it", target: 0.75, sourceIds: [], topics: [] });
      // The build is running, as the wait screen follows it.
      const now = Date.now();
      db.prepare(
        "INSERT INTO jobs(id,kind,params_json,state,progress,error,created_at,updated_at) VALUES('j-build','plan-build',?,'running',0.4,NULL,?,?)",
      ).run(JSON.stringify({ planId: "p-build" }), now, now);
      const step = db.prepare("INSERT INTO job_steps(id,job_id,name,position,label,state) VALUES(?,?,?,?,?,?)");
      step.run("js0", "j-build", "sources", 0, "wizard.stepSources", "succeeded");
      step.run("js1", "j-build", "topics", 1, "wizard.stepTopics", "running");
    } finally {
      db.close();
    }
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Esami" })).toBeVisible();

    const swipe = () =>
      app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.emit("swipe", {}, "left");
      });
    const mouse = () =>
      page.evaluate(() => window.dispatchEvent(new MouseEvent("mouseup", { button: 3, bubbles: true, cancelable: true })));
    const leave = page.getByRole("dialog", { name: "Uscire senza salvare?" });
    const name = page.getByRole("textbox", { name: "Nome dell'esame", exact: true });
    const control = (place: string) => page.getByRole("button", { name: `Torna a ${place}` });
    const open = async () => {
      await page.getByRole("button", { name: "Nuovo esame" }).click();
      await expect(name).toBeVisible();
    };

    // Nothing typed: leaving asks nothing, and the first step has no foot button for the way back.
    await open();
    await expect(page.getByRole("button", { name: "Indietro", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Chiudi", exact: true })).toHaveCount(0);
    await control("Esami").click();
    await expect(page).toHaveURL(/#\/exams$/);
    await expect(leave).toHaveCount(0);

    // A name typed: the menu's Indietro, the swipe, the mouse's side button and the control all ask, once.
    await open();
    await name.fill("Fisica generale");
    for (const way of [() => pick(app, "back"), swipe, mouse, () => control("Esami").click()]) {
      await way();
      await expect(leave).toBeVisible();
      await expect(leave).toContainText("Quello che hai scritto o scelto per questo esame andrà perso.");
      await leave.getByRole("button", { name: "Resta qui" }).click();
      await expect(leave).toHaveCount(0);
      await expect(page).toHaveURL(/#\/plans\/new$/);
      await expect(name).toHaveValue("Fisica generale");
    }
    await control("Esami").click();
    await leave.getByRole("button", { name: "Esci senza salvare" }).click();
    await expect(page).toHaveURL(/#\/exams$/);

    // The guided exam: the exam step and the material step with nothing picked lead to it.
    await open();
    await name.fill("Fisica generale");
    await page.getByRole("button", { name: "Non ho ancora la data" }).click();
    await page.getByRole("button", { name: "Continua", exact: true }).click();
    await page.getByRole("button", { name: "Passo precedente" }).click();
    await expect(name).toHaveValue("Fisica generale");
    await page.getByRole("button", { name: "Continua", exact: true }).click();
    await page.getByRole("button", { name: "Continua", exact: true }).click();
    await expect(page).toHaveURL(/#\/plans\/new\/guided$/);
    await expect(page.getByText("Passo 1 di 4 · Periodo")).toBeVisible();
    // Step 1 has no foot button for the way back. Moving to the new exam and forward again asks nothing.
    await expect(page.getByRole("button", { name: "Passo precedente" })).toHaveCount(0);
    await control("Nuovo esame").click();
    await expect(page).toHaveURL(/#\/plans\/new$/);
    await expect(leave).toHaveCount(0);
    await pick(app, "forward");
    await expect(page).toHaveURL(/#\/plans\/new\/guided$/);
    await expect(leave).toHaveCount(0);

    // An answer given: every way out asks, and leaving returns to the new exam with its answers.
    await page.getByRole("group", { name: "Periodo" }).getByRole("button").first().click();
    for (const way of [() => pick(app, "back"), swipe, mouse, () => control("Nuovo esame").click()]) {
      await way();
      await expect(leave).toBeVisible();
      await expect(leave).toContainText("Le risposte che hai dato andranno perse.");
      await leave.getByRole("button", { name: "Resta qui" }).click();
      await expect(leave).toHaveCount(0);
      await expect(page).toHaveURL(/#\/plans\/new\/guided$/);
    }
    await control("Nuovo esame").click();
    await leave.getByRole("button", { name: "Esci senza salvare" }).click();
    await expect(page).toHaveURL(/#\/plans\/new$/);
    await expect(page.getByRole("heading", { name: "Da cosa studi?" })).toBeVisible();
    await page.getByRole("button", { name: "Passo precedente" }).click();
    await expect(name).toHaveValue("Fisica generale");
    await control("Esami").click();
    await leave.getByRole("button", { name: "Esci senza salvare" }).click();
    await expect(page).toHaveURL(/#\/exams$/);

    // The wait while an exam builds holds nothing: its build goes on in Attività, so leaving asks nothing.
    await page.evaluate(() => {
      location.hash = "/plans/new?build=p-build";
    });
    await expect(page.getByRole("heading", { level: 1, name: "Nuovo esame" })).toBeVisible();
    await expect(page.getByText("Chimica", { exact: true }).first()).toBeVisible();
    await control("Esami").click();
    await expect(page).toHaveURL(/#\/exams$/);
    await expect(leave).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/**
 * Every field the new exam holds counts as work that leaving would lose, not only the name: a room typed before a date
 * is chosen, a name for the test, a goal moved.
 */
test("any field written or changed on the new exam is asked about, and the untouched form is not", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-leave-fields-"));
  const app = await launchPyxis({ userData });
  try {
    const page: Page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const leave = page.getByRole("dialog", { name: "Uscire senza salvare?" });
    const control = page.getByRole("button", { name: "Torna a Esami" });
    const changes: Array<[string, () => Promise<void>]> = [
      ["a room", () => page.getByRole("textbox", { name: /^Luogo/ }).fill("Aula 5")],
      ["a name for the test", () => page.getByRole("textbox", { name: /^Nome \(facoltativo\)/ }).fill("Scritto")],
      ["a subject", () => page.getByRole("combobox", { name: "Materia", exact: true }).fill("Fisica")],
      ["the goal", async () => {
        const goal = page.getByRole("slider", { name: /^Obiettivo/ });
        await goal.focus();
        await page.keyboard.press("ArrowRight");
      }],
    ];
    for (const [what, change] of changes) {
      await page.getByRole("button", { name: "Nuovo esame" }).click();
      await expect(page.getByRole("textbox", { name: "Nome dell'esame", exact: true })).toBeVisible();
      // Untouched, the form is left without a question; once changed, leaving asks.
      await change();
      await control.click();
      await expect(leave, what).toBeVisible();
      await leave.getByRole("button", { name: "Esci senza salvare" }).click();
      await expect(page).toHaveURL(/#\/exams$/);
    }
    await page.getByRole("button", { name: "Nuovo esame" }).click();
    await control.click();
    await expect(page).toHaveURL(/#\/exams$/);
    await expect(leave).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/**
 * The guided exam hands the answers it was given back to the new exam, so going forward again to it asks nothing only
 * while the new exam still holds those answers. Edited meanwhile, Avanti would restore the old ones, so it asks.
 */
test("Avanti into the guided exam asks once the new exam's answers changed since it was opened", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-leave-forward-"));
  const app = await launchPyxis({ userData });
  try {
    const page: Page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const leave = page.getByRole("dialog", { name: "Uscire senza salvare?" });
    const name = page.getByRole("textbox", { name: "Nome dell'esame", exact: true });
    await page.getByRole("button", { name: "Nuovo esame" }).click();
    await name.fill("Fisica A");
    await page.getByRole("button", { name: "Non ho ancora la data" }).click();
    for (let i = 0; i < 2; i++) await page.getByRole("button", { name: "Continua", exact: true }).click();
    await expect(page).toHaveURL(/#\/plans\/new\/guided$/);
    await page.getByRole("button", { name: "Torna a Nuovo esame" }).click();
    await expect(page).toHaveURL(/#\/plans\/new$/);
    // Unchanged, Avanti returns to the guided exam without a question.
    await pick(app, "forward");
    await expect(page).toHaveURL(/#\/plans\/new\/guided$/);
    await expect(leave).toHaveCount(0);
    await page.getByRole("button", { name: "Torna a Nuovo esame" }).click();
    await expect(page.getByRole("heading", { name: "Da cosa studi?" })).toBeVisible();
    await page.getByRole("button", { name: "Passo precedente" }).click();
    await name.fill("Fisica B");
    // Changed, Avanti would restore "Fisica A": it asks, and staying keeps the new name.
    await pick(app, "forward");
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Resta qui" }).click();
    await expect(page).toHaveURL(/#\/plans\/new$/);
    await expect(name).toHaveValue("Fisica B");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
