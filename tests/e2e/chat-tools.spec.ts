import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis, setUp } from "./app-under-test";
import { TOOL_CARDS } from "./chat-look-seed";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { saveShot } from "./shots";

/*
 * The chat's flashcard tool. The recorded engine calls the tool through the app's own MCP server, as Claude Code, Codex
 * or Antigravity would, so the server, its token, the save and the three states of the reply all run for real; only the
 * model's words are recorded.
 */

const QUESTION = "Fammi 8 flashcard sui tre principi della dinamica.";

function reply(hold: string) {
  return [
    "Ecco le flashcard che mi hai chiesto.",
    `@@tool create_flashcards ${JSON.stringify({ _hold: hold, title: "sui tre principi della dinamica", cards: TOOL_CARDS })}`,
    "Le trovi nel mazzo di Fisica 1: ripassale domani.",
  ].join("\n");
}

function seed(userData: string) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  try {
    db.exec(`
      INSERT INTO subjects(id,name,created_at) VALUES('phys','Fisica 1',1);
      INSERT INTO chats(id,title,subject,scope_json,created_at,updated_at)
        VALUES('tool-chat','I tre principi della dinamica','Fisica 1','{"planId":null,"ids":[],"subjectBy":"student"}',1,2);
      INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('q0','tool-chat','user','Che cosa studia la dinamica?',1);
      INSERT INTO messages(id,chat_id,role,body,engine_provider,model_id,model_source,created_at)
        VALUES('a0','tool-chat','assistant','La dinamica studia il moto dei corpi a partire dalle forze che lo causano.','claude','claude-sonnet-5-5','reported',2);
    `);
  } finally {
    db.close();
  }
}

function removed(userData: string): number[] {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  try {
    return (db.prepare("SELECT removed FROM cards ORDER BY rowid").all() as Array<{ removed: number }>).map((row) => row.removed);
  } finally {
    db.close();
  }
}

const openChat = async (page: Page) => {
  await page.evaluate(() => {
    location.hash = "/ask/tool-chat";
  });
  await expect(page.getByRole("textbox", { name: "Messaggio" })).toBeVisible();
  // The subject chip is drawn only once the chat itself has loaded, and Enter does nothing before that.
  await expect(page.getByRole("button", { name: /^Materia(:| della chat:)/ })).toBeVisible();
};

/** A picture of the reply in each theme, kept for review when PYXIS_SHOTS names a folder. */
async function shots(page: Page, name: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
    await saveShot(page, `chat-tools/${name}-${theme}.png`, { animations: "disabled" });
  }
  await page.evaluate(() => window.pyxis.setAppearance("light"));
}

test("a chat answer creates flashcards with the tool: at work, done, undone and restored, after a reopen and a restart", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-tools-"));
  const hold = join(userData, "tool-go");
  const env = { PYXIS_E2E_REPLY: reply(hold), PYXIS_E2E_REPLY_DELAY: "600" };
  const app = await launchPyxis({ userData, env });
  const page = await setUp(app, userData, async () => {
    const first = await app.firstWindow();
    await first.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(first);
    seed(userData);
    await first.evaluate(() => window.pyxis.setAppearance("light"));
    return first;
  });
  let again: Awaited<ReturnType<typeof launchPyxis>> | undefined;
  try {
    await openChat(page);
    // Enter sends only once the chat is read, which its earlier answer on screen shows.
    await expect(page.getByText("La dinamica studia il moto dei corpi a partire dalle forze che lo causano.")).toBeVisible();
    await page.getByRole("textbox", { name: "Messaggio" }).fill(QUESTION);
    await page.keyboard.press("Enter");

    // At work: the text so far, then the quiet line and the grey shape where the card will be. Stop is there.
    const answer = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(answer.getByText("Creo le flashcard…")).toBeVisible({ timeout: 30000 });
    await expect(answer.locator(".px-toolres-ghost")).toBeVisible();
    await expect(page.getByRole("button", { name: "Interrompi", exact: true })).toBeVisible();
    await expect(answer.getByText("Ecco le flashcard che mi hai chiesto.")).toBeVisible();
    await shots(page, "working");

    // Done: the card takes the shape's place, and the answer goes on after it with one sentence.
    writeFileSync(hold, "");
    const card = answer.getByRole("region", { name: "Flashcard create" });
    await expect(card).toBeVisible({ timeout: 30000 });
    await expect(card.getByText("8 flashcard sui tre principi della dinamica")).toBeVisible();
    await expect(card.getByRole("listitem")).toHaveCount(3);
    await expect(card.getByRole("listitem").first()).toHaveText(TOOL_CARDS[0]!.front);
    await expect(card.getByText("e altre 5")).toBeVisible();
    await expect(answer.getByText("Le trovi nel mazzo di Fisica 1: ripassale domani.")).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("button", { name: "Interrompi", exact: true })).toHaveCount(0, { timeout: 30000 });
    // The stored reply keeps the card in the same place, between the two sentences.
    const stored = page.locator(".px-msg:not(.px-msg-user)").last();
    const order = await stored.locator(".px-msg-text").innerText();
    expect(order.indexOf("Ecco le flashcard")).toBeLessThan(order.indexOf("Flashcard create"));
    expect(order.indexOf("Flashcard create")).toBeLessThan(order.indexOf("Le trovi nel mazzo"));
    expect(removed(userData)).toEqual(Array(8).fill(0));
    await shots(page, "done");

    // «Annulla»: the cards leave the deck and the card becomes one line with «Ripristina», which takes the focus.
    await stored.getByRole("button", { name: "Annulla" }).click();
    await expect(stored.getByText("8 flashcard annullate: non sono più nel mazzo.")).toBeVisible();
    await expect(stored.getByRole("button", { name: "Ripristina" })).toBeFocused();
    expect(removed(userData)).toEqual(Array(8).fill(1));
    await shots(page, "undone");
    await stored.getByRole("button", { name: "Ripristina" }).click();
    await expect(stored.getByRole("region", { name: "Flashcard create" })).toBeVisible();
    await expect(stored.getByRole("button", { name: "Annulla" })).toBeFocused();
    expect(removed(userData)).toEqual(Array(8).fill(0));

    // Undone, then the chat is left and reopened: it is still undone.
    await stored.getByRole("button", { name: "Annulla" }).click();
    await expect(stored.getByRole("button", { name: "Ripristina" })).toBeVisible();
    await page.evaluate(() => {
      location.hash = "/exams";
    });
    await expect(page.getByRole("textbox", { name: "Messaggio" })).toHaveCount(0);
    await openChat(page);
    await expect(page.getByText("8 flashcard annullate: non sono più nel mazzo.")).toBeVisible();
    await app.close();

    // After a restart the reply shows its result again, and «Ripristina» still works.
    again = await launchPyxis({ userData, env });
    const later = await again.firstWindow();
    await openChat(later);
    const line = later.getByText("8 flashcard annullate: non sono più nel mazzo.");
    await expect(line).toBeVisible({ timeout: 30000 });
    await later.getByRole("button", { name: "Ripristina" }).click();
    await expect(later.getByRole("region", { name: "Flashcard create" })).toBeVisible();
    expect(removed(userData)).toEqual(Array(8).fill(0));

    // «Apri» lists those cards in Flashcard, and only them until the student asks for all.
    await later.getByRole("region", { name: "Flashcard create" }).getByRole("button", { name: "Apri" }).click();
    await expect(later).toHaveURL(/#\/flashcards\/all\?made=/);
    await expect(later.getByText("Solo le flashcard create nella chat.")).toBeVisible();
    for (const card of TOOL_CARDS.filter((item) => !item.front.includes("$")))
      await expect(later.getByText(card.front, { exact: true })).toBeVisible();
  } finally {
    await (again ?? app).close().catch(() => undefined);
    removeTestFolder(userData);
  }
});
