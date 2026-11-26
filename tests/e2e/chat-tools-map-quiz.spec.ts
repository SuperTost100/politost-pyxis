import { expect, test, type Page } from "@playwright/test";
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
 * The chat's map and quiz tools. The recorded engine calls each tool through the app's own MCP server, as a CLI would,
 * and the map and the quiz are made by their real background jobs from recorded model replies. A hold file keeps a job at
 * work until the test creates it, so the card can be seen working after the reply has ended, and across a restart.
 */

/** A map of the dynamics, as the map build's recorded model gives it: 14 concepts in 3 branches. */
const MAP = (() => {
  const branches: Array<[string, string[]]> = [
    ["Forze", ["Peso", "Reazione normale", "Tensione", "Forza elastica"]],
    ["Tre principi", ["Inerzia", "F = ma", "Azione e reazione"]],
    ["Attrito", ["Statico", "Dinamico", "Coefficiente"]],
  ];
  const nodes = [{ id: "root", label: "Dinamica", parent: null as string | null, sources: ["{{passage:0}}"] }];
  branches.forEach(([branch, leaves], b) => {
    nodes.push({ id: `b${b}`, label: branch, parent: "root", sources: ["{{passage:0}}"] });
    leaves.forEach((leaf, l) => nodes.push({ id: `b${b}l${l}`, label: leaf, parent: `b${b}`, sources: ["{{passage:0}}"] }));
  });
  return { result: { kind: "map", nodes, edges: [] } };
})();

/** Five questions in the order a quiz of every kind asks them: two in the first call, three in the second. */
const QUESTIONS = [
  { kind: "mcq", stem: "Quale forza si oppone al moto relativo di due superfici?", options: ["L'attrito", "Il peso", "La tensione", "La spinta"], correct: 0 },
  { kind: "tf", stem: "L'attrito statico può superare il suo valore massimo.", correct: false },
  { kind: "completion", stem: "La forza d'attrito dinamico vale $\\mu_d$ per la {{1}}.", accepted: ["reazione normale", "forza normale"] },
  { kind: "matching", stem: "Abbina ogni forza alla sua causa.", pairs: [["Peso", "Gravità"], ["Normale", "Contatto"], ["Attrito", "Rugosità"]] },
  { kind: "open", stem: "Spiega perché un blocco fermo su un piano inclinato non scivola.", reference: "L'attrito statico bilancia la componente del peso lungo il piano.", rubric: ["Nomina l'attrito statico", "Scompone il peso"] },
].map((question) => ({ ...question, explanation: "L'attrito si oppone al moto relativo delle superfici a contatto.", passageIds: ["{{passage:0}}"] }));

function seed(userData: string, chat: { planId: string | null }) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  try {
    seedSubjects(db, [{ id: "phys", name: "Fisica 1" }]);
    seedSource(db, {
      id: "notes",
      title: "Appunti di dinamica",
      subjectId: "phys",
      document: { id: "notes-doc" },
      passages: [
        { id: "pa-1", text: "La forza di attrito si oppone al moto relativo delle superfici a contatto.", section: "Attrito" },
        { id: "pa-2", text: "Il secondo principio lega forza risultante, massa e accelerazione.", section: "Principi" },
      ],
    });
    seedPlan(db, { id: "p-mech", subjectId: "phys", title: "Fisica 1", topics: [{ id: "t-dyn", title: "Dinamica" }] });
    db.exec("INSERT INTO topic_passages(topic_id,passage_id) SELECT 't-dyn', id FROM passages WHERE source_id = 'notes'");
    db.prepare(
      `INSERT INTO chats(id,title,subject,scope_json,created_at,updated_at) VALUES('tool-chat','La dinamica','Fisica 1',?,1,2)`,
    ).run(JSON.stringify({ planId: chat.planId, ids: [], subjectBy: "student" }));
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

const mapCount = (userData: string) =>
  query<{ graph_json: string }>(userData, "SELECT graph_json FROM maps").reduce(
    (sum, row) => sum + (JSON.parse(row.graph_json) as { maps: unknown[] }).maps.length,
    0,
  );

/** The ids of every map in Mappe, in the order their rows hold them. */
const mapIds = (userData: string) =>
  query<{ graph_json: string }>(userData, "SELECT graph_json FROM maps").flatMap(
    (row) => (JSON.parse(row.graph_json) as { maps: Array<{ id: string }> }).maps.map((map) => map.id),
  );

const openChat = async (page: Page) => {
  await page.evaluate(() => {
    location.hash = "/ask/tool-chat";
  });
  await expect(page.getByRole("textbox", { name: "Messaggio" })).toBeVisible();
};

async function ask(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Messaggio" }).fill(text);
  await page.keyboard.press("Enter");
}

/** A picture of the reply in each theme, kept for review when PYXIS_SHOTS names a folder. */
async function shots(page: Page, name: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
    await saveShot(page, `chat-tools/${name}-${theme}.png`, { animations: "disabled" });
  }
  await page.evaluate(() => window.pyxis.setAppearance("light"));
}

async function start(userData: string, env: Record<string, string>, chat: { planId: string | null }) {
  // The profile is this test's from here: a launch that fails removes it, as `setUp` does for a failed setup, and the
  // launch's own error is what the test reports.
  let app: Awaited<ReturnType<typeof launchPyxis>>;
  try {
    app = await launchPyxis({ userData, env });
  } catch (error) {
    try {
      removeTestFolder(userData);
    } catch (leftover) {
      console.error(`start: ${userData} was not removed: ${(leftover as Error).message}`);
    }
    throw error;
  }
  const page = await setUp(app, userData, async () => {
    const first = await app.firstWindow();
    await first.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(first);
    seed(userData, chat);
    await first.evaluate(() => window.pyxis.setAppearance("light"));
    await first.reload();
    return first;
  });
  return { app, page };
}

test("a chat answer creates a map: at work after the reply, across a restart, done, undone and restored, opened and answered again", async () => {
  test.setTimeout(300000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-map-"));
  const hold = join(userData, "map-go");
  const env = {
    PYXIS_E2E_REPLY: [
      "Ho raccolto dagli appunti i concetti della dinamica e come si legano tra loro.",
      `@@tool create_map ${JSON.stringify({ topic: "dinamica" })}`,
      "Il ramo sull'attrito è il più povero: negli appunti c'è solo quello dinamico.",
    ].join("\n"),
    PYXIS_E2E_REPLY_DELAY: "600",
    PYXIS_E2E_MAP_REPLIES: JSON.stringify({ result: [{ ...MAP, hold }] }),
  };
  let { app, page } = await start(userData, env, { planId: null });
  try {
    await openChat(page);
    await ask(page, "Mi fai una mappa della dinamica dai miei appunti?");

    // At work: the line with its own Ferma and the grey shape, and the answer goes on and ends while the map is built.
    const answer = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(answer.getByText("Creo la mappa…")).toBeVisible({ timeout: 30000 });
    await expect(answer.locator(".px-toolres-ghost-preview")).toBeVisible();
    await expect(answer.getByText("Il ramo sull'attrito è il più povero", { exact: false })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("button", { name: "Interrompi", exact: true })).toHaveCount(0, { timeout: 30000 });
    const saved = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(saved.getByText("Creo la mappa…")).toBeVisible();
    await expect(saved.getByRole("button", { name: "Ferma" })).toBeVisible();
    await shots(page, "map-working");

    // Pyxis closes while the map is built. After a restart the card is still at work, and the build goes on.
    await app.close();
    app = await launchPyxis({ userData, env });
    page = await app.firstWindow();
    await openChat(page);
    await expect(page.getByText("Creo la mappa…")).toBeVisible({ timeout: 30000 });
    expect(query<{ state: string }>(userData, "SELECT state FROM jobs WHERE kind = 'map-build'").map((row) => row.state)).toEqual([
      expect.stringMatching(/^(queued|running)$/),
    ]);

    // Done: the card grows out of the shape, with the map's outline, what it holds and where it is.
    writeFileSync(hold, "");
    const card = page.getByRole("region", { name: "Mappa creata" });
    await expect(card).toBeVisible({ timeout: 30000 });
    await expect(card.getByText("Dinamica", { exact: true })).toBeVisible();
    await expect(card.getByText("14 concetti in 3 rami. È in Mappe, sotto Fisica 1.")).toBeVisible();
    expect(mapCount(userData)).toBe(1);
    await expect(card.getByRole("link", { name: "Mappe" })).toBeVisible();
    await shots(page, "map-done");

    // «Annulla»: the map leaves Mappe, the card becomes one line and «Ripristina» takes the focus.
    await card.getByRole("button", { name: "Annulla" }).click();
    await expect(page.getByText("Mappa annullata: non è più in Mappe.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Ripristina" })).toBeFocused();
    expect(mapCount(userData)).toBe(0);
    await shots(page, "map-undone");
    await page.getByRole("button", { name: "Ripristina" }).click();
    await expect(page.getByRole("region", { name: "Mappa creata" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Annulla" })).toBeFocused();
    expect(mapCount(userData)).toBe(1);

    // Left and reopened, the chat shows the map as it stands.
    await page.evaluate(() => {
      location.hash = "/exams";
    });
    await expect(page.getByRole("textbox", { name: "Messaggio" })).toHaveCount(0);
    await openChat(page);
    await expect(page.getByText("14 concetti in 3 rami. È in Mappe, sotto Fisica 1.")).toBeVisible();

    // «Apri» opens the map in Mappe.
    await page.getByRole("region", { name: "Mappa creata" }).getByRole("button", { name: "Apri" }).click();
    await expect(page).toHaveURL(/#\/maps\/phys\?from=maps&map=/);
    await expect(page.getByText("Tre principi").first()).toBeVisible({ timeout: 30000 });

    // Answered again: the new answer's map replaces the earlier one, which leaves Mappe with it, and its result goes too.
    await openChat(page);
    const [earlierMap] = mapIds(userData);
    const [earlierResult] = query<{ id: string }>(userData, "SELECT id FROM chat_tool_results").map((row) => row.id);
    await page.getByRole("button", { name: "Rigenera" }).last().click();
    await expect(page.getByRole("button", { name: "Interrompi", exact: true })).toHaveCount(0, { timeout: 60000 });
    await expect.poll(() => mapIds(userData), { timeout: 30000 }).toEqual([expect.not.stringMatching(`^${earlierMap}$`)]);
    const results = query<{ id: string }>(userData, "SELECT id FROM chat_tool_results").map((row) => row.id);
    expect(results).toHaveLength(1);
    expect(results[0]).not.toBe(earlierResult);
    await expect(page.getByRole("region", { name: "Mappa creata" })).toBeVisible();
  } finally {
    await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});

test("an exam chat creates a quiz and a map in one answer: Ferma, a failed build and its retry, done, undone and opened", async () => {
  test.setTimeout(300000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-quiz-"));
  const hold = join(userData, "quiz-go");
  const env = {
    PYXIS_E2E_REPLY: [
      "Ti preparo un quiz sull'attrito e una mappa della dinamica.",
      `@@tool create_quiz ${JSON.stringify({ topic: "Dinamica", questions: 5 })}`,
      `@@tool create_map ${JSON.stringify({ topic: "Dinamica" })}`,
      "Quando lo consegni, il voto entra nel percorso come gli altri quiz.",
    ].join("\n"),
    PYXIS_E2E_REPLY_DELAY: "400",
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({ quizQuestions: [{ hold, questions: QUESTIONS }] }),
    // The map's first build fails on the tool's usage limit; «Riprova» builds it.
    PYXIS_E2E_MAP_REPLIES: JSON.stringify({ result: [{ fail: "quota [claude]: You've hit your usage limit." }, MAP] }),
  };
  const { app, page } = await start(userData, env, { planId: "p-mech" });
  try {
    await openChat(page);
    await ask(page, "Preparami un quiz sulla dinamica, voglio vedere se sono pronta.");
    const answer = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(answer.getByText("Creo il quiz…")).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("button", { name: "Interrompi", exact: true })).toHaveCount(0, { timeout: 30000 });
    const saved = page.locator(".px-msg:not(.px-msg-user)").last();
    await shots(page, "quiz-working");

    // The failed map: a plain line with the job's reason and «Riprova».
    await expect(saved.getByText("La mappa non è stata creata.", { exact: false })).toBeVisible({ timeout: 30000 });
    await expect(saved.getByText("Hai raggiunto il limite di utilizzo", { exact: false })).toBeVisible();
    await shots(page, "map-failed");
    await saved.getByRole("button", { name: "Riprova" }).click();
    await expect(saved.getByRole("region", { name: "Mappa creata" })).toBeVisible({ timeout: 30000 });

    // «Ferma» on the quiz at work stops its writing and takes it out of the exam. No quiz was made, so the line says the
    // writing stopped, not that a quiz left the exam, and «Riprendi» goes on with it.
    await saved.getByRole("button", { name: "Ferma" }).click();
    await expect(saved.getByText("La scrittura del quiz si è fermata.")).toBeVisible();
    await expect(saved.getByText("Quiz annullato", { exact: false })).toHaveCount(0);
    await expect.poll(() => query(userData, "SELECT id FROM attempts")).toHaveLength(0);
    await shots(page, "quiz-stopped");
    await saved.getByRole("button", { name: "Riprendi" }).click();
    await expect(saved.getByText("Creo il quiz…")).toBeVisible();
    // The keyboard stays at the card: «Riprendi» gives way to «Ferma», which takes the focus.
    await expect(saved.getByRole("button", { name: "Ferma" })).toBeFocused();

    // Done: what the quiz holds, about how long it takes and where it is.
    writeFileSync(hold, "");
    const card = saved.getByRole("region", { name: "Quiz creato" });
    await expect(card).toBeVisible({ timeout: 60000 });
    await expect(card.getByText("Dinamica, 5 domande")).toBeVisible();
    await expect(
      card.getByText(
        "1 a scelta multipla, 1 vero o falso, 1 da completare, 1 da abbinare e 1 aperta, circa 8 minuti. È nell’esame Fisica 1, tra le cose da finire.",
      ),
    ).toBeVisible();
    await shots(page, "quiz-done");

    // «Annulla»: the quiz leaves the exam's unfinished activities, and «Ripristina» puts it back with its questions.
    await card.getByRole("button", { name: "Annulla" }).click();
    await expect(saved.getByText("Quiz annullato: non è più nell’esame.")).toBeVisible();
    expect(query(userData, "SELECT id FROM items WHERE kind = 'quiz'")).toHaveLength(0);
    const unfinished = await page.evaluate(() => window.pyxis.invoke("plans.unfinished", { planId: "p-mech" }));
    expect(unfinished).toEqual([]);
    await shots(page, "quiz-undone");
    await saved.getByRole("button", { name: "Ripristina" }).click();
    await expect(saved.getByRole("region", { name: "Quiz creato" })).toBeVisible();
    expect(await page.evaluate(() => window.pyxis.invoke("plans.unfinished", { planId: "p-mech" }))).toHaveLength(1);

    // «Apri» starts the quiz on its first question.
    await saved.getByRole("region", { name: "Quiz creato" }).getByRole("button", { name: "Apri" }).click();
    await expect(page).toHaveURL(/#\/plans\/p-mech\/quiz\/t-dyn\?attempt=/);
    await expect(page.getByText("Quale forza si oppone al moto relativo di due superfici?")).toBeVisible({ timeout: 30000 });
  } finally {
    await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});

test("a chat opened from an exam's topic belongs to that exam, so its quiz goes there when the subject has two exams", async () => {
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-topic-"));
  const env = {
    PYXIS_E2E_REPLY: [
      "Ti preparo un quiz sulla dinamica.",
      `@@tool create_quiz ${JSON.stringify({ topic: "Dinamica", questions: 5 })}`,
      "Lo trovi tra le cose da finire.",
    ].join("\n"),
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({ quizQuestions: [{ questions: QUESTIONS }] }),
  };
  const { app, page } = await start(userData, env, { planId: null });
  try {
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    try {
      seedPlan(db, { id: "p-opt", subjectId: "phys", title: "Ottica", topics: [{ id: "t-lens", title: "Lenti" }] });
    } finally {
      db.close();
    }
    await page.evaluate(() => {
      location.hash = "/plans/p-mech";
    });
    await page.getByRole("button", { name: /Dinamica/, expanded: false }).first().click();
    await page.getByRole("button", { name: "Chiedi al tutor" }).click();
    await expect(page).toHaveURL(/#\/ask\//);
    const chatId = decodeURIComponent(page.url().split("#/ask/")[1]!.split("?")[0]!);
    const [chat] = query<{ scope_json: string; subject: string }>(userData, `SELECT scope_json, subject FROM chats WHERE id = '${chatId}'`);
    expect(JSON.parse(chat!.scope_json)).toMatchObject({ planId: "p-mech" });
    expect(chat!.subject).toBe("Fisica 1");
    // A quiz asked for there goes in that exam, though the subject has another.
    await ask(page, "Preparami un quiz sulla dinamica.");
    await expect(page.getByRole("region", { name: "Quiz creato" })).toBeVisible({ timeout: 60000 });
    expect(query<{ plan_id: string }>(userData, "SELECT plan_id FROM attempts").map((row) => row.plan_id)).toEqual(["p-mech"]);
    expect(await page.evaluate(() => window.pyxis.invoke("plans.unfinished", { planId: "p-mech" }))).toHaveLength(1);
    expect(await page.evaluate(() => window.pyxis.invoke("plans.unfinished", { planId: "p-opt" }))).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});
