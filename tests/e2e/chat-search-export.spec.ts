import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedSource } from "./seed";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { answerNextMenu, lastMenuLabels } from "./native-menu";

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
    await fromChiediToExams(page);
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
    // The recent chats sit in the sidebar.
    const list = page.getByRole("list", { name: "Chat" });
    await expect(list.getByRole("listitem")).toHaveCount(2);

    // "Tutte le chat" opens the search over every chat. The plain spelling finds the accented word; the snippet shows
    // where.
    await page.getByRole("button", { name: "Tutte le chat" }).click();
    const finder = page.getByRole("dialog", { name: "Cerca" });
    const search = finder.getByRole("combobox", { name: "Cerca" });
    await expect(finder.getByRole("option")).toHaveCount(2);
    await search.fill("perche");
    await expect(finder.getByRole("option")).toHaveCount(1);
    await expect(finder.getByRole("option", { name: /^Termodinamica/ })).toContainText("Perché il calore passa");
    await expect(page.getByRole("status").filter({ hasText: "1 chat trovata" })).toBeAttached();
    // Stored followups are not text a student sees.
    await search.fill("nascosto");
    await expect(finder.getByText("Niente con queste parole.")).toBeVisible();

    // Enter opens the highlighted chat and closes the search.
    await search.fill("PERCHÉ");
    await expect(finder.getByRole("option")).toHaveCount(1);
    await search.press("Enter");
    await expect(page).toHaveURL(/#\/ask\/c-termo$/);
    await expect(finder).toBeHidden();
    await expect(
      page.locator(".ask-thread").getByText("Perché il calore passa dal caldo al freddo?"),
    ).toBeVisible();

    // Cmd+K (Ctrl+K elsewhere) opens the search over everything, empty again; Esc closes it.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    await expect(search).toHaveValue("");
    await expect(search).toHaveAttribute("placeholder", "Cerca chat, esami, mappe e materiale");
    await page.keyboard.press("Escape");
    await expect(finder).toBeHidden();

    const exportWith = async (item: string) => {
      await answerNextMenu(app, item);
      await page
        .getByRole("button", { name: "Azioni per Termodinamica" })
        .click();
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
    // The Markdown export's "File saved" may still be showing, so wait for the file itself.
    await expect.poll(() => readFileSync(saved).subarray(0, 5).toString()).toBe("%PDF-");

    // Renaming an older chat leaves it where it was in the list.
    await answerNextMenu(app, "Rinomina");
    await page.getByRole("button", { name: "Azioni per Analisi" }).click();
    const rename = page.getByRole("textbox", { name: "Nome della chat" });
    await rename.fill("Limiti");
    await rename.press("Enter");
    await expect(list.getByRole("link", { name: /^Limiti/ })).toBeVisible();
    await expect(list.getByRole("link").first()).toHaveText(/Termodinamica/);
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
    await answerNextMenu(app, "Export as Markdown");
    await page
      .getByRole("button", { name: "Actions for Termodinamica" })
      .click();
    await expect.poll(() => lastMenuLabels(app)).toContain("Export as Markdown");
    await expect(page.getByText("File saved")).toBeVisible();
    const english = readFileSync(saved, "utf8");
    expect(english).toContain("## Student");
    expect(english).toContain("**Sources**");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
