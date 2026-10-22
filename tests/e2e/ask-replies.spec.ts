import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";

const CONTINUATION = " ha un massimo e un minimo su un intervallo chiuso.";

/** A chat whose reply the engine cut short, and a week of token usage with prompt-cache reads. */
function seed(userData: string) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
    timeout: 10000,
  });
  const now = Date.now();
  db.exec(`
    INSERT INTO chats(id,title,created_at,updated_at) VALUES('chat-cut','Teorema di Weierstrass',${now},${now});
    INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('m-q','chat-cut','user','Che cosa dice il teorema di Weierstrass?',${now});
    INSERT INTO messages(id,chat_id,role,body,engine_provider,model_id,model_source,stopped,error,created_at)
      VALUES('m-a','chat-cut','assistant','Il teorema dice che ogni funzione continua','claude','claude-sonnet-5','reported',1,'engines.errors.stream-truncated',${now + 1});
    INSERT INTO engine_usage(id,at,provider,model,kind,chat_id,message_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
      VALUES('u1',${now},'claude','claude-sonnet-5','chat','chat-cut','m-a',18400,2100,0,0),
            ('u2',${now},'anthropic-api','claude-sonnet-5','lesson',NULL,NULL,52000,6300,31000,4000);
  `);
  db.close();
}

test("Ask: a reply cut short offers Continue, the reply menu answers with the strongest model, and Settings shows the week", async () => {
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-ask-replies-"));
  const env = {
    PYXIS_E2E_REPLY: CONTINUATION,
    // The recorded reply waits before its first piece, so the moments right after Continue can be checked.
    PYXIS_E2E_REPLY_DELAY: "4000",
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    seed(userData);
    await page.evaluate(() => {
      location.hash = "/ask/chat-cut";
    });
    await page.reload();

    const reply = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(reply.getByText("Interrotta")).toBeVisible();
    await expect(
      reply.getByText("Il motore si è fermato prima di finire la risposta."),
    ).toBeVisible();
    // The chat's own tokens sit in the bar: 18,400 sent and 2,100 received.
    await expect(page.locator(".ask-usage")).toContainText("20,5");

    await reply.getByRole("button", { name: "Continua" }).click();
    // Before the engine sends anything, the saved part stays on screen instead of a thinking placeholder.
    await expect(
      page.locator(".px-msg:not(.px-msg-user) .px-msg-text"),
    ).toHaveText("Il teorema dice che ogni funzione continua", { timeout: 1500 });
    await expect(
      page.getByText(
        "Il teorema dice che ogni funzione continua ha un massimo e un minimo su un intervallo chiuso.",
      ),
    ).toBeVisible({ timeout: 30000 });
    await expect(page.getByText("Interrotta")).toHaveCount(0);
    await expect(page.locator(".px-msg:not(.px-msg-user)")).toHaveCount(1);

    await page
      .locator(".px-msg:not(.px-msg-user)")
      .getByRole("button", { name: "Altre azioni" })
      .click();
    await expect(
      page.getByRole("menuitem", {
        name: "Rispondi di nuovo con il modello più potente",
      }),
    ).toBeVisible();
    await page
      .getByRole("menuitem", {
        name: "Rispondi di nuovo con il modello più potente",
      })
      .click();
    // The recorded reply answers again and replaces the continued one.
    await expect(
      page.locator(".px-msg:not(.px-msg-user) .px-msg-text"),
    ).toHaveText(CONTINUATION.trim(), { timeout: 30000 });
    await expect(page.locator(".px-msg:not(.px-msg-user)")).toHaveCount(1);

    await page.evaluate(() => {
      location.hash = "/settings/engines";
    });
    const week = page.getByRole("region", { name: "Questa settimana" });
    await expect(week).toBeVisible();
    await expect(week.getByRole("row", { name: /Anthropic/ })).toContainText(
      "31.000 (60%)",
    );
    await expect(week.getByText(/la cache dei prompt ha servito/)).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("Ask: Continue keeps the cut reply's citation chips while it waits for the engine", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-ask-replies-"));
  const env = {
    PYXIS_E2E_REPLY: CONTINUATION,
    PYXIS_E2E_REPLY_DELAY: "4000",
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    const now = Date.now();
    db.exec(`
      INSERT INTO sources(id,kind,title,status,library,created_at,updated_at) VALUES('src-an','excerpt','Dispense di analisi','ready',1,1,1);
      INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES('d-an','src-an',1,'{"kind":"excerpt"}',1);
      INSERT INTO passages(id,source_id,document_id,text,locator_json,section_path,created_at)
        VALUES('pa-w','src-an','d-an','Una funzione continua su un intervallo chiuso ha massimo e minimo.','{"chapter":1,"paragraph":"p1"}','3. Weierstrass',1);
      INSERT INTO chats(id,title,created_at,updated_at) VALUES('chat-cut','Teorema di Weierstrass',${now},${now});
      INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('m-q','chat-cut','user','Che cosa dice il teorema di Weierstrass?',${now});
      INSERT INTO messages(id,chat_id,role,body,engine_provider,model_id,model_source,stopped,error,passages_json,created_at)
        VALUES('m-a','chat-cut','assistant','Il teorema [P1] dice che ogni funzione continua','claude','claude-sonnet-5','reported',1,'engines.errors.stream-truncated','[{"passageId":"pa-w","index":1}]',${now + 1});
      INSERT INTO message_passages(message_id,passage_id,label) VALUES('m-a','pa-w','P1');
    `);
    db.close();
    await page.evaluate(() => {
      location.hash = "/ask/chat-cut";
    });
    await page.reload();

    const reply = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(reply.locator(".px-cite")).toHaveCount(1);
    // Every state the page shows is recorded: core sends the passages again only after retrieval, and until then the
    // saved part must keep its chip rather than flash a bare [P1].
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      const note = () => {
        for (const reply of document.querySelectorAll(".px-msg:not(.px-msg-user)"))
          if (reply.textContent?.includes("[P1]")) seen.push(reply.textContent);
      };
      new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await reply.getByRole("button", { name: "Continua" }).click();
    await expect(page.getByRole("button", { name: "Interrompi", exact: true })).toBeVisible();
    await expect(reply.locator(".px-cite")).toHaveCount(1);
    await expect(page.getByText(CONTINUATION.trim(), { exact: false })).toBeVisible({ timeout: 30000 });
    expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
