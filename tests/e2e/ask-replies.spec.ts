import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAIN = join(
  process.cwd(),
  process.env.PYXIS_OUT ?? "out",
  "main/index.js",
);

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
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_REPLY: CONTINUATION,
    // The recorded reply waits before its first piece, so the moments right after Continue can be checked.
    PYXIS_E2E_REPLY_DELAY: "4000",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
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
