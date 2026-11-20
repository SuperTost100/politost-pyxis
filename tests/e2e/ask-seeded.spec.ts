import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

test("Ask: a chat opened with Chiedi stores nothing until its first message is sent", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-ask-seeded-"));
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_REPLY: "Perché la divisione per zero non è definita." } });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const chatsInDatabase = () => {
      const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
      try {
        return db.prepare("SELECT COUNT(*) AS n FROM chats").get() as { n: number };
      } finally {
        db.close();
      }
    };
    // What the quiz results do with "Chiedi": open a chat with the question pinned.
    const { chatId } = await page.evaluate(() =>
      window.pyxis.invoke("chats.seed", { kind: "answer", title: "Quanto fa 1 diviso 0?", body: "Domanda: quanto fa 1 diviso 0?\nLa tua risposta: 0" }),
    );
    await page.evaluate((id) => {
      location.hash = `/ask/${id}`;
    }, chatId);
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await expect(box).toBeVisible();
    // Nothing is stored and the sidebar lists no chat; going back leaves nothing behind.
    expect(chatsInDatabase().n).toBe(0);
    expect(await page.evaluate(() => window.pyxis.invoke("chats.list", {}))).toEqual([]);
    await page.evaluate(() => {
      location.hash = "/exams";
    });
    expect(chatsInDatabase().n).toBe(0);
    // The first message stores the chat, under the same id, and the list shows it.
    await page.evaluate((id) => {
      location.hash = `/ask/${id}`;
    }, chatId);
    await box.fill("Perché non si può?");
    await box.press("Enter");
    await expect(page.getByText("Perché la divisione per zero non è definita.")).toBeVisible({ timeout: 30000 });
    expect(chatsInDatabase().n).toBe(1);
    expect(await page.evaluate(() => window.pyxis.invoke("chats.list", {}))).toHaveLength(1);
    await expect(page.getByRole("link", { name: /Quanto fa 1 diviso 0/ })).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
