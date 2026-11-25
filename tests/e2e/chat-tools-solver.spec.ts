import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis, setUp } from "./app-under-test";
import { SOLVER_ARGS, SOLVER_QUESTION } from "./chat-look-seed";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { saveShot } from "./shots";

/*
 * A hard exercise handed to the stronger model. The recorded engine calls `ask_stronger_model` through the app's own MCP
 * server, as a CLI would, and the server runs the sub-call on the recorded engine too, as the strong model of the chat's
 * tool that the stored automatic row names (the fixture lists no models, so no plan runs before it). The tool, its working line, its stored result and
 * the tag under the answer run for real; only the models' words are recorded.
 */

const SOLUTION = [
  "1. Lungo il piano agiscono $mg\\sin\\theta$ verso il basso e l'attrito $\\mu mg\\cos\\theta$ verso l'alto.",
  "2. Quindi $a = g(\\sin\\theta - \\mu\\cos\\theta) = 9{,}81\\,(0{,}5 - 0{,}2 \\cdot 0{,}866) \\approx 3{,}2\\,\\mathrm{m/s^2}$.",
  "3. Da fermo, $v = \\sqrt{2 a d} = \\sqrt{2 \\cdot 3{,}2 \\cdot 3} \\approx 4{,}4\\,\\mathrm{m/s}$.",
  "Controllo: con $\\mu = 0$ si ritrova $a = g/2$, come deve essere.",
].join("\n");

function reply(solver: string[]) {
  return [
    "@@engine claude claude-sonnet-5-5",
    "Imposto il problema con il secondo principio lungo il piano.",
    `@@tool ask_stronger_model ${JSON.stringify(SOLVER_ARGS)}`,
    "L'accelerazione è $a \\approx 3{,}2\\,\\mathrm{m/s^2}$ e dopo 3 m la velocità è circa $4{,}4\\,\\mathrm{m/s}$.",
    "@@solver",
    ...solver,
    SOLUTION,
  ].join("\n");
}

function seed(userData: string) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  try {
    db.exec(`
      INSERT INTO subjects(id,name,created_at) VALUES('phys','Fisica 1',1);
      INSERT INTO chats(id,title,subject,scope_json,created_at,updated_at)
        VALUES('solver-chat','Piano inclinato','Fisica 1','{"planId":null,"ids":[],"subjectBy":"student"}',1,2);
      INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('q0','solver-chat','user','Che cosa studia la dinamica?',1);
      INSERT INTO messages(id,chat_id,role,body,engine_provider,model_id,model_source,created_at)
        VALUES('a0','solver-chat','assistant','La dinamica studia il moto dei corpi a partire dalle forze che lo causano.','claude','claude-sonnet-5-5','reported',2);
      INSERT OR REPLACE INTO feature_engines(feature,selection_json,updated_at)
        VALUES('solve','{"provider":"claude","model":"claude-opus-5-5","auto":true}',1);
    `);
  } finally {
    db.close();
  }
}

function solverRows(userData: string): Array<{ tool: string; message_id: string | null }> {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  try {
    return db.prepare("SELECT tool, message_id FROM chat_tool_results").all() as Array<{ tool: string; message_id: string | null }>;
  } finally {
    db.close();
  }
}

const openChat = async (page: Page) => {
  await page.evaluate(() => {
    location.hash = "/ask/solver-chat";
  });
  await expect(page.getByText("La dinamica studia il moto dei corpi a partire dalle forze che lo causano.")).toBeVisible();
};

/** A picture of the answer in each theme, kept for review when PYXIS_SHOTS names a folder. */
async function shots(page: Page, name: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
    await saveShot(page, `chat-solver/${name}-${theme}.png`, { animations: "disabled" });
  }
  await page.evaluate(() => window.pyxis.setAppearance("light"));
}

async function start(env: Record<string, string>) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-solver-"));
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_REPLY_DELAY: "600", ...env } });
  const page = await setUp(app, userData, async () => {
    const first = await app.firstWindow();
    await first.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(first);
    seed(userData);
    await first.evaluate(() => window.pyxis.setAppearance("light"));
    return first;
  });
  return { userData, app, page };
}

test("a hard exercise goes to the stronger model: the working line, then the answer tagged with both models, also reopened", async () => {
  test.setTimeout(180000);
  const userData0 = mkdtempSync(join(tmpdir(), "pyxis-chat-solver-hold-"));
  const hold = join(userData0, "solver-go");
  const { userData, app, page } = await start({ PYXIS_E2E_REPLY: reply([`@@hold ${hold}`]) });
  try {
    await openChat(page);
    await page.getByRole("textbox", { name: "Messaggio" }).fill(SOLVER_QUESTION);
    await page.keyboard.press("Enter");

    // At work: the text so far, then one quiet line with the time it has taken. No card shape: nothing is being made.
    const answer = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(answer.getByText("Chiedo al modello più forte…")).toBeVisible({ timeout: 30000 });
    const time = answer.locator(".px-toolres.is-working .px-toolres-activity");
    await expect(time).toHaveText(/^0:0\d$/);
    await expect(time).not.toHaveText("0:00", { timeout: 5000 });
    await expect(answer.locator(".px-toolres-ghost")).toHaveCount(0);
    await expect(answer.getByText("Imposto il problema con il secondo principio lungo il piano.")).toBeVisible();
    await shots(page, "working");

    // Done: the line goes and the answer goes on. Under it, the tag names the model that wrote it and the one that solved it.
    writeFileSync(hold, "");
    await expect(answer.getByText("dopo 3 m la velocità è circa")).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("button", { name: "Interrompi", exact: true })).toHaveCount(0, { timeout: 30000 });
    const stored = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(stored.getByText("Chiedo al modello più forte…")).toHaveCount(0);
    await expect(stored.locator(".px-toolres")).toHaveCount(0);
    await expect(stored.locator(".px-msg-engine")).toHaveText("Claude · Claude Sonnet 5.5 con Claude Opus 5.5");
    const rows = solverRows(userData);
    expect(rows).toEqual([{ tool: "ask_stronger_model", message_id: expect.any(String) }]);
    await shots(page, "done");

    // Reopened, the answer keeps its tag.
    await page.evaluate(() => {
      location.hash = "/exams";
    });
    await expect(page.getByRole("textbox", { name: "Messaggio" })).toHaveCount(0);
    await openChat(page);
    await expect(page.locator(".px-msg:not(.px-msg-user)").last().locator(".px-msg-engine")).toHaveText(
      "Claude · Claude Sonnet 5.5 con Claude Opus 5.5",
    );
  } finally {
    await app.close().catch(() => undefined);
    removeTestFolder(userData);
    removeTestFolder(userData0);
  }
});

test("a stronger model that does not answer in time leaves the answer to the chat's model, tagged with that model alone", async () => {
  test.setTimeout(120000);
  const userData0 = mkdtempSync(join(tmpdir(), "pyxis-chat-solver-never-"));
  // The hold is never created: the sub-call runs past its deadline, shortened to 3 seconds.
  const { userData, app, page } = await start({
    PYXIS_E2E_REPLY: reply([`@@hold ${join(userData0, "never")}`, "@@deadline 3000"]),
  });
  try {
    await openChat(page);
    await page.getByRole("textbox", { name: "Messaggio" }).fill(SOLVER_QUESTION);
    await page.keyboard.press("Enter");
    const answer = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(answer.getByText("Chiedo al modello più forte…")).toBeVisible({ timeout: 30000 });
    // The turn does not hang: the line goes, the answer ends, and nothing of the sub-call stays.
    await expect(answer.getByText("dopo 3 m la velocità è circa")).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("button", { name: "Interrompi", exact: true })).toHaveCount(0, { timeout: 30000 });
    const stored = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(stored.getByText("Chiedo al modello più forte…")).toHaveCount(0);
    await expect(stored.locator(".px-msg-engine")).toHaveText("Claude · Claude Sonnet 5.5");
    expect(solverRows(userData)).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    removeTestFolder(userData);
    removeTestFolder(userData0);
  }
});
