import { expect, test, type Page } from "@playwright/test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis, setUp } from "./app-under-test";
import { GRADES_CHART, PRACTICE_QUESTION, seedBlocksChat } from "./chat-look-seed";
import { answerNextMenu } from "./native-menu";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { saveShot, SHOTS } from "./shots";
import { clickSettled } from "./settled";

/*
 * The chat's own blocks: a chart the app draws from the numbers in the answer, and a practice question answered in the
 * chat. The recorded engine writes the answer and calls read_progress through the app's own MCP server, as a CLI would.
 */

/** The chart pretty-printed, so the block takes many streamed pieces and its placeholder stays on screen a while. */
function chartReply(hold: string) {
  return [
    "Bene su tre argomenti su quattro.",
    `@@tool read_progress ${JSON.stringify({ _hold: hold })}`,
    "Ecco l'ultimo voto di ognuno.",
    "",
    "```pyxis-chart",
    JSON.stringify(GRADES_CHART, null, 2),
    "```",
    "",
    "Il punto debole sono le oscillazioni. Termodinamica non l'hai ancora cominciata.",
  ].join("\n");
}

const questionReply = ["Eccone una che trae in inganno spesso.", "", "```pyxis-question", JSON.stringify(PRACTICE_QUESTION), "```"].join("\n");

function seed(userData: string) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  try {
    db.exec(`
      INSERT INTO subjects(id,name,created_at) VALUES('phys','Fisica 1',1);
      INSERT INTO chats(id,title,subject,scope_json,created_at,updated_at)
        VALUES('blocks-chat','Come vado in Fisica 1','Fisica 1','{"planId":null,"ids":[],"subjectBy":"student"}',1,2);
      INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('q0','blocks-chat','user','Me lo fai un grafico?',1);
      INSERT INTO messages(id,chat_id,role,body,engine_provider,model_id,model_source,created_at)
        VALUES('a0','blocks-chat','assistant','Ci provo.

\`\`\`pyxis-chart
{"title": "Voti", "kind": "torta", "series": []}
\`\`\`','claude','claude-sonnet-5-5','reported',2);
    `);
  } finally {
    db.close();
  }
}

/** Rows of the tables that count answers, and the practice answers kept with replies. */
function counted(userData: string) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  try {
    const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    return {
      graded: ["attempts", "attempt_answers", "gaps", "gap_answers", "card_reviews", "learning_events"].map(count),
      practice: count("chat_question_answers"),
    };
  } finally {
    db.close();
  }
}

const openChat = async (page: Page) => {
  await page.evaluate(() => {
    location.hash = "/ask/blocks-chat";
  });
  await expect(page.getByRole("textbox", { name: "Messaggio" })).toBeVisible();
};

async function shots(page: Page, name: string, act?: () => Promise<void>) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
    await act?.();
    await saveShot(page, `blocks/${name}-${theme}.png`, { animations: "disabled" });
  }
  await page.evaluate(() => window.pyxis.setAppearance("light"));
}

async function start(env: Record<string, string>) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-blocks-"));
  const app = await launchPyxis({ userData, env });
  const page = await setUp(app, userData, async () => {
    const first = await app.firstWindow();
    await first.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(first);
    seed(userData);
    // The tools' notice is confirmed before the chat opens, so its dialog cannot come up over the chart when a recorded
    // tool turns ready during the test.
    await first.evaluate(() => window.pyxis.invoke("engines.acknowledge", { providers: ["claude", "codex", "antigravity"] }));
    await first.evaluate(() => window.pyxis.setAppearance("light"));
    return first;
  });
  return { userData, app, page };
}

test("a chart grows out of its placeholder, shows values on hover and focus, turns into a table and copies as text", async () => {
  test.setTimeout(240000);
  const hold = join(tmpdir(), `pyxis-chart-hold-${process.pid}-${Date.now()}`);
  const { userData, app, page } = await start({ PYXIS_E2E_REPLY: chartReply(hold), PYXIS_E2E_REPLY_DELAY: "6000" });
  try {
    await openChat(page);
    // A block that does not validate is one quiet line, never its JSON.
    await expect(page.getByText("Non è stato possibile disegnare il grafico.")).toBeVisible();
    await expect(page.getByText('"torta"')).toHaveCount(0);

    await page.getByRole("textbox", { name: "Messaggio" }).fill("Come sto andando nei quiz di Fisica 1?");
    await page.keyboard.press("Enter");
    const answer = page.locator(".px-msg:not(.px-msg-user)").last();
    // read_progress at work: one quiet line where it was called.
    await expect(answer.getByText("Guardo i tuoi risultati…")).toBeVisible({ timeout: 30000 });
    await shots(page, "reading");
    writeFileSync(hold, "");
    // The block is still being written: its placeholder holds the place, never the raw JSON.
    await expect(answer.getByText("Disegno il grafico…")).toBeVisible({ timeout: 30000 });
    await expect(answer.getByText('"series"')).toHaveCount(0);
    await shots(page, "chart-writing");
    const chart = page.locator("figure.px-chart");
    await expect(chart.getByText("I tuoi voti nei quiz di Fisica 1")).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("button", { name: "Interrompi", exact: true })).toHaveCount(0, { timeout: 30000 });
    await expect(answer.getByText("Guardo i tuoi risultati…")).toHaveCount(0);

    // A bar says its quiz on hover, and on focus from the keyboard.
    const stored = page.locator("figure.px-chart").last();
    const bars = stored.locator(".px-chart-hit");
    await expect(bars).toHaveCount(5);
    await bars.first().hover();
    await expect(stored.locator(".px-chart-tip")).toHaveText("Cinematica: 26/30 · quiz del 9 novembre");
    await shots(page, "chart", async () => {
      await bars.first().hover();
    });
    await page.mouse.move(0, 0);
    await bars.nth(4).focus();
    await expect(stored.locator(".px-chart-tip")).toHaveText("Termodinamica: non ancora fatto");
    await expect(bars.nth(4)).toHaveAttribute("aria-label", "Termodinamica: non ancora fatto");
    // The same data is a table for screen readers.
    await expect(stored.getByRole("table")).toContainText("Oscillazioni");

    // The menu opens on right-click, with what makes sense for a chart.
    await stored.click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText(["Ingrandisci", "Mostra come tabella", "Scarica PNG", "Copia immagine"]);
    await shots(page, "chart-menu", async () => {
      if (!(await menu.isVisible())) await stored.click({ button: "right" });
    });
    await menu.getByRole("menuitem", { name: "Mostra come tabella" }).click();
    await expect(stored.locator(".px-chart-plot")).toHaveCount(0);
    await expect(stored.locator(".px-chart-table")).toBeVisible();
    await expect(stored.locator(".px-chart-table tbody tr")).toHaveCount(5);
    await shots(page, "chart-table");
    await stored.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mostra come grafico" }).click();
    await expect(stored.locator(".px-chart-plot")).toBeVisible();

    // Copia immagine puts a PNG of the chart on the clipboard.
    await stored.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Copia immagine" }).click();
    await expect(stored.getByRole("status")).toHaveText("Copiata");
    const picture = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const blob = await item!.getType("image/png");
      const bitmap = await createImageBitmap(blob);
      return { width: bitmap.width, height: bitmap.height };
    });
    // Drawn at twice the chart's size, with the title over it.
    expect(picture.width).toBeGreaterThan(600);
    expect(picture.height).toBeGreaterThan(300);
    // Ingrandisci opens the picture in the viewer, from the keyboard too, and closing it gives the focus back to the dots.
    const dots = stored.getByRole("button", { name: "Altro sul grafico" });
    await dots.focus();
    await page.keyboard.press("Enter");
    await clickSettled(page, page.getByRole("menuitem", { name: "Ingrandisci" }));
    await expect(page.getByRole("dialog", { name: "Grafico ingrandito" })).toBeVisible();
    await shots(page, "chart-viewer");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Grafico ingrandito" })).toHaveCount(0);
    await expect(dots).toBeFocused();

    // «Copia» on the answer pastes the chart's data as a table, not its JSON.
    await answer.hover();
    await page.locator(".px-msg:not(.px-msg-user)").last().getByRole("button", { name: "Copia", exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("| Cinematica | 26/30 (quiz del 9 novembre) |");
    expect(copied).toContain("| Termodinamica | non ancora fatto |");
    expect(copied).not.toContain("pyxis-chart");
  } finally {
    await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});

test("a practice question is answered in the chat, kept after a reopen and a restart, and counts nowhere", async () => {
  test.setTimeout(240000);
  const env = { PYXIS_E2E_REPLY: questionReply, PYXIS_E2E_REPLY_DELAY: "300" };
  const { userData, app, page } = await start(env);
  let again: Awaited<ReturnType<typeof launchPyxis>> | undefined;
  try {
    const before = counted(userData);
    await openChat(page);
    await page.getByRole("textbox", { name: "Messaggio" }).fill("Credo di aver capito l'attrito statico. Mi fai una domanda per controllare?");
    await page.keyboard.press("Enter");
    const group = page.getByRole("radiogroup", { name: "Risposte" });
    await expect(group).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("button", { name: "Interrompi", exact: true })).toHaveCount(0, { timeout: 30000 });
    const check = page.getByRole("button", { name: "Controlla" });
    await expect(check).toBeDisabled();
    await expect(page.getByText("È solo per provare: non conta nei voti.")).toBeVisible();
    await shots(page, "question");

    // The keyboard: the group is one stop, the arrows move the choice, Space picks.
    const radios = group.getByRole("radio");
    await expect(radios).toHaveCount(3);
    const wrong = (await radios.allInnerTexts()).findIndex((text) => text.includes("sempre"));
    await radios.first().focus();
    for (let i = 0; i < wrong; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press(" ");
    await expect(radios.nth(wrong)).toHaveAttribute("aria-checked", "true");
    await expect(radios.nth(wrong)).toBeFocused();
    await expect(check).toBeEnabled();
    await expect(check).toHaveClass(/ant-btn-primary/);
    // «Controlla» is the next step, so Invia goes quiet until the answer is checked.
    const send = page.getByRole("button", { name: "Invia", exact: true });
    await expect(send).not.toHaveClass(/ant-btn-primary/);
    await shots(page, "question-picked");

    await page.keyboard.press("Tab");
    await expect(check).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(radios.nth(wrong)).toContainText("La tua risposta");
    await expect(group.getByRole("radio").filter({ hasText: "Quella giusta" })).toContainText("quanto basta a tenerlo fermo");
    await expect(page.getByText("Non proprio.")).toBeVisible();
    await expect(page.getByText(/L'attrito statico non ha un valore fisso/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Un'altra domanda", exact: true })).toBeFocused();
    await expect(send).toHaveClass(/ant-btn-primary/);
    await expect(page.getByText("È solo per provare: non conta nei voti.")).toBeVisible();
    await shots(page, "question-done");
    // Kept with the reply, and in none of the tables that count.
    expect(counted(userData)).toEqual({ graded: before.graded, practice: 1 });

    // Left and opened again: still answered.
    await page.evaluate(() => {
      location.hash = "/exams";
    });
    await expect(page.getByRole("textbox", { name: "Messaggio" })).toHaveCount(0);
    await openChat(page);
    await expect(page.getByText("La tua risposta")).toBeVisible();
    await app.close();

    // After a restart too; «Un'altra domanda» asks the chat for one more.
    again = await launchPyxis({ userData, env });
    const later = await again.firstWindow();
    await openChat(later);
    await expect(later.getByText("La tua risposta")).toBeVisible({ timeout: 30000 });
    await expect(later.getByText("Quella giusta")).toBeVisible();
    await later.getByRole("button", { name: "Un'altra domanda", exact: true }).click();
    await expect(later.locator(".px-msg-user").last()).toContainText("Fammi un'altra domanda sullo stesso argomento.");
    // The new question arrives; «Un'altra domanda» is offered only on the latest question, never on an older card, whose
    // topic may no longer be the one the chat is on.
    await expect(later.getByRole("radiogroup", { name: "Risposte" })).toHaveCount(2, { timeout: 30000 });
    await expect(later.getByRole("button", { name: "Interrompi", exact: true })).toHaveCount(0, { timeout: 30000 });
    await expect(later.getByRole("button", { name: "Un'altra domanda", exact: true })).toHaveCount(0);
    const newest = later.locator(".px-msg:not(.px-msg-user)").last();
    await newest.getByRole("radio").first().click();
    await newest.getByRole("button", { name: "Controlla" }).click();
    await expect(later.getByRole("button", { name: "Un'altra domanda", exact: true })).toHaveCount(1);
    await expect(newest.getByRole("button", { name: "Un'altra domanda", exact: true })).toBeVisible();
    expect(counted(userData).graded).toEqual(before.graded);
  } finally {
    await (again ?? app).close().catch(() => undefined);
    removeTestFolder(userData);
  }
});

/** The text a PDF holds, page after page, as pdf.js reads it. */
async function pdfText(path: string): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: true }).promise;
  const pages: string[] = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const content = await (await doc.getPage(number)).getTextContent();
    pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return pages.join("\n").replace(/\s+/g, " ");
}

test("a chat with a chart exports its data as a table in Markdown and prints the chart in the PDF", async () => {
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-blocks-export-"));
  const saved = join(userData, "export.bin");
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_SAVE: saved } });
  try {
    const page = await setUp(app, userData, async () => {
      const first = await app.firstWindow();
      await first.getByRole("button", { name: "Salta" }).click();
      await fromChiediToExams(first);
      const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
      try {
        seedBlocksChat(db, "chart");
      } finally {
        db.close();
      }
      return first;
    });
    await page.evaluate(() => {
      location.hash = "/ask/look-chart";
    });
    await expect(page.locator("figure.px-chart")).toBeVisible();
    const exportWith = async (item: string) => {
      rmSync(saved, { force: true });
      await answerNextMenu(app, item);
      await page.getByRole("button", { name: "Azioni per Come vado in Fisica 1" }).click();
      await expect.poll(() => readFileSync(saved, { flag: "a+" }).length, { timeout: 30000 }).toBeGreaterThan(0);
    };
    await exportWith("Esporta come Markdown");
    const markdown = readFileSync(saved, "utf8");
    expect(markdown).toContain("| Argomento | Voto |");
    expect(markdown).toContain("| Oscillazioni | 17/30 (quiz del 16 novembre) |");
    expect(markdown).not.toContain("pyxis-chart");

    await exportWith("Esporta come PDF");
    await expect.poll(() => readFileSync(saved).subarray(0, 5).toString(), { timeout: 30000 }).toBe("%PDF-");
    // The drawing's own labels are in the PDF (the value at each bar's end, the reference line's label), and no table.
    if (SHOTS) {
      mkdirSync(join(SHOTS, "blocks"), { recursive: true });
      copyFileSync(saved, join(SHOTS, "blocks", "chart-print.pdf"));
    }
    const text = await pdfText(saved);
    expect(text).toContain("I tuoi voti nei quiz di Fisica 1");
    expect(text).toContain("26/30");
    expect(text).toContain("sufficienza, 18");
    expect(text).toContain("non ancora fatto");
    expect(text).not.toContain("|");
    expect(text).not.toContain('"series"');
  } finally {
    await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});

test("two replies with the same question keep their own picks: checking one leaves Invia quiet while the other waits", async () => {
  test.setTimeout(120000);
  const { userData, app, page } = await start({});
  try {
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    try {
      const block = "```pyxis-question\n" + JSON.stringify(PRACTICE_QUESTION) + "\n```";
      const message = db.prepare("INSERT INTO messages(id,chat_id,role,body,engine_provider,model_id,model_source,created_at) VALUES(?,?,?,?,?,?,?,?)");
      message.run("twin-q1", "blocks-chat", "user", "Mettimi alla prova.", null, null, null, 3);
      message.run("twin-a1", "blocks-chat", "assistant", `Eccone una.\n\n${block}`, "claude", "claude-sonnet-5-5", "reported", 4);
      message.run("twin-q2", "blocks-chat", "user", "Rifammela.", null, null, null, 5);
      message.run("twin-a2", "blocks-chat", "assistant", `Eccola di nuovo.\n\n${block}`, "claude", "claude-sonnet-5-5", "reported", 6);
    } finally {
      db.close();
    }
    await openChat(page);
    const groups = page.getByRole("radiogroup", { name: "Risposte" });
    await expect(groups).toHaveCount(2);
    const send = page.getByRole("button", { name: "Invia", exact: true });
    for (const index of [0, 1]) await groups.nth(index).getByRole("radio").first().click();
    await expect(send).not.toHaveClass(/ant-btn-primary/);
    await page.getByRole("button", { name: "Controlla" }).first().click();
    await expect(page.getByText("Quella giusta")).toHaveCount(1);
    // The other reply's pick still waits for «Controlla», so Invia stays quiet.
    await expect(send).not.toHaveClass(/ant-btn-primary/);
    await page.getByRole("button", { name: "Controlla" }).click();
    await expect(page.getByText("Quella giusta")).toHaveCount(2);
    await expect(send).toHaveClass(/ant-btn-primary/);
  } finally {
    await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});

test("a reply with a chart, a question and citations keeps its sources row under it, and no mark shows in the blocks", async () => {
  test.setTimeout(120000);
  const { userData, app, page } = await start({});
  try {
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    try {
      db.exec(`INSERT INTO sources(id,kind,title,status,library,created_at,updated_at) VALUES('blk-src','pdf','Fisica, Mazzoldi','ready',1,1,1);
        INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES('blk-doc','blk-src',1,'{"kind":"pdf"}',1);
        INSERT INTO passages(id,source_id,document_id,text,locator_json,section_path,created_at)
          VALUES('blk-p1','blk-src','blk-doc','La sufficienza è 18 su 30.','{"page":12}',NULL,1);`);
      const chart = { ...GRADES_CHART, title: "I tuoi voti nei quiz di Fisica 1 [P1]", subtitle: "In trentesimi [P1]" };
      const question = { ...PRACTICE_QUESTION, question: `${PRACTICE_QUESTION.question} [P1]` };
      const body = [
        "La sufficienza è 18 [P1].",
        "```pyxis-chart\n" + JSON.stringify(chart) + "\n```",
        "```pyxis-question\n" + JSON.stringify(question) + "\n```",
      ].join("\n\n");
      const message = db.prepare("INSERT INTO messages(id,chat_id,role,body,engine_provider,model_id,model_source,grounding,created_at) VALUES(?,?,?,?,?,?,?,?,?)");
      message.run("cite-q", "blocks-chat", "user", "Come vado?", null, null, null, null, 3);
      message.run("cite-a", "blocks-chat", "assistant", body, "claude", "claude-sonnet-5-5", "reported", "sources", 4);
      db.prepare("INSERT INTO message_passages(message_id,passage_id,label) VALUES('cite-a','blk-p1','P1')").run();
    } finally {
      db.close();
    }
    await openChat(page);
    const reply = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(reply.locator("figure.px-chart")).toBeVisible();
    await expect(reply.getByRole("radiogroup", { name: "Risposte" })).toBeVisible();
    // One source is named by the row itself.
    const row = reply.getByRole("button", { name: "Fisica, Mazzoldi, p. 12" });
    await expect(row).toBeVisible();
    // The row comes after the blocks, under the whole answer.
    const [chartBox, questionBox, rowBox] = await Promise.all([
      reply.locator("figure.px-chart").boundingBox(),
      reply.locator(".px-qb").boundingBox(),
      row.boundingBox(),
    ]);
    expect(rowBox!.y).toBeGreaterThan(chartBox!.y + chartBox!.height);
    expect(rowBox!.y).toBeGreaterThan(questionBox!.y + questionBox!.height);
    // As in a figure's caption, a mark inside a block the app draws is left out; in the text it is an empty anchor.
    await expect(reply).not.toContainText("[P1]");
    await expect(reply.locator(".px-chart-title")).toHaveText("I tuoi voti nei quiz di Fisica 1");
    await shots(page, "blocks-with-sources");
  } finally {
    await app.close().catch(() => undefined);
    removeTestFolder(userData);
  }
});
