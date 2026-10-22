import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedSource } from "./seed";

const ANSWER = [
  "Il calore passa per conduzione: \\(Q=mc\\Delta T\\) [P1].",
  "",
  "<followups>",
  "Fammi un esempio nascosto",
  "</followups>",
].join("\n");

test("a student finds a chat by an accented word, opens it and exports it as Markdown and PDF", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-search-"));
  const saved = join(userData, "export.bin");
  const env = {
    PYXIS_E2E_SAVE: saved,
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10000,
    });
    seedSource(db, {
      id: "s1",
      title: "Appunti di fisica",
      document: { id: "d1" },
      passages: [
        { id: "p1", text: "Il calore si trasmette per conduzione.", locator: {}, section: "2. Termodinamica" },
      ],
    });
    db.exec(`
      INSERT INTO chats(id,title,created_at,updated_at) VALUES('c-termo','Termodinamica',1,2),('c-analisi','Analisi',1,1);
      INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('m1','c-termo','user','Perché il calore passa dal caldo al freddo?',1);
      INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('m3','c-analisi','user','Come calcolo un limite?',1);
    `);
    db.prepare(
      "INSERT INTO messages(id,chat_id,role,body,grounding,created_at) VALUES('m2','c-termo','assistant',?,'sources',2)",
    ).run(ANSWER);
    db.exec(
      "INSERT INTO message_passages(message_id,passage_id,label) VALUES('m2','p1','P1')",
    );
    // A chat started from a passage keeps that passage as its pinned context.
    db.prepare("UPDATE chats SET context_json = ? WHERE id = 'c-termo'").run(
      JSON.stringify({
        kind: "passage",
        title: "Primo principio",
        body: "Il calore si trasmette per conduzione.",
      }),
    );
    db.close();

    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.getByRole("button", { name: "Apri le chat" }).click();
    const list = page.getByRole("list", { name: "Chat" });
    await expect(list.getByRole("listitem")).toHaveCount(2);

    // The plain spelling finds the accented word; the snippet shows where.
    const search = page.getByRole("textbox", { name: "Cerca nelle chat" });
    await search.fill("perche");
    const results = page.getByRole("list", { name: "Risultati della ricerca" });
    await expect(results.getByRole("listitem")).toHaveCount(1);
    await expect(
      results.getByRole("button", { name: /^Termodinamica/ }),
    ).toContainText("Perché il calore passa");
    await expect(
      page.getByRole("status").filter({ hasText: "1 chat trovata" }),
    ).toBeAttached();
    // Stored followups are not text a student sees.
    await search.fill("nascosto");
    await expect(
      page.getByText("Nessuna chat contiene “nascosto”."),
    ).toBeVisible();

    await search.fill("PERCHÉ");
    await results.getByRole("button", { name: /^Termodinamica/ }).click();
    await expect(page).toHaveURL(/#\/ask\/c-termo$/);
    await expect(
      page.getByText("Perché il calore passa dal caldo al freddo?"),
    ).toBeVisible();
    // Closing the drawer cleared the search.
    await page.getByRole("button", { name: "Apri le chat" }).click();
    await expect(search).toHaveValue("");
    await expect(list.getByRole("listitem")).toHaveCount(2);

    const exportWith = async (item: string) => {
      await page
        .getByRole("button", { name: "Azioni per Termodinamica" })
        .click();
      await page.getByRole("menuitem", { name: item }).click();
      await expect(page.getByText("File salvato")).toBeVisible();
    };
    await exportWith("Esporta come Markdown");
    const markdown = readFileSync(saved, "utf8");
    expect(markdown).toBe(
      [
        "# Termodinamica",
        "**Contesto:** Primo principio",
        "> Il calore si trasmette per conduzione.",
        "## Studente",
        "Perché il calore passa dal caldo al freddo?",
        "## Pyxis",
        "Il calore passa per conduzione: $Q=mc\\Delta T$.",
        "**Fonti**",
        "- Appunti di fisica, 2. Termodinamica",
      ].join("\n\n") + "\n",
    );

    await exportWith("Esporta come PDF");
    expect(readFileSync(saved).subarray(0, 5).toString()).toBe("%PDF-");

    // Renaming an older chat leaves it where it was in the list.
    await page.getByRole("button", { name: "Azioni per Analisi" }).click();
    await page.getByRole("menuitem", { name: "Rinomina" }).click();
    const rename = page.getByRole("textbox", { name: "Nome della chat" });
    await rename.fill("Limiti");
    await rename.press("Enter");
    await expect(list.getByRole("button", { name: /^Limiti/ })).toBeVisible();
    await expect(list.getByRole("button").first()).toHaveText(/Termodinamica/);
    const check = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
    expect(
      check
        .prepare("SELECT updated_at FROM chats WHERE id = 'c-analisi'")
        .get(),
    ).toEqual({ updated_at: 1 });
    check.close();

    // The labels follow the interface language.
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    await page.reload();
    await page.getByRole("button", { name: "Open chats" }).click();
    await page
      .getByRole("button", { name: "Actions for Termodinamica" })
      .click();
    await page.getByRole("menuitem", { name: "Export as Markdown" }).click();
    await expect(page.getByText("File saved")).toBeVisible();
    const english = readFileSync(saved, "utf8");
    expect(english).toContain("## Student");
    expect(english).toContain("**Sources**");
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
