import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

test("Ask: a chat opened with Chiedi is listed only from its first message, and leaving it unsent leaves nothing", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-ask-seeded-"));
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_REPLY: "Perché la divisione per zero non è definita." } });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    // The sidebar lists recent chats only while it is open, from 1100 CSS px, so the window gets that width.
    await page.setViewportSize({ width: 1280, height: 800 });
    const chatsInDatabase = () => {
      const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
      try {
        return (db.prepare("SELECT COUNT(*) AS n FROM chats").get() as { n: number }).n;
      } finally {
        db.close();
      }
    };
    const listed = () => page.evaluate(() => window.pyxis.invoke("chats.list", {}));
    const seed = (title: string) =>
      page.evaluate(
        (name) => window.pyxis.invoke("chats.seed", { kind: "answer", title: name, body: "Domanda: quanto fa 1 diviso 0?\nLa tua risposta: 0" }),
        title,
      );
    const open = async (id: string) => {
      await page.evaluate((chat) => {
        location.hash = `/ask/${chat}`;
      }, id);
      await expect(page.getByRole("textbox", { name: "Messaggio" })).toBeVisible();
    };
    const leave = async () => {
      await page.evaluate(() => {
        location.hash = "/exams";
      });
      await expect(page.getByRole("textbox", { name: "Messaggio" })).toHaveCount(0);
    };
    const box = page.getByRole("textbox", { name: "Messaggio" });

    // What the quiz results do with "Chiedi": open a chat with the question pinned. It is a chat, with no message yet:
    // the title shows in the header, and neither the list nor the sidebar names it.
    const { chatId } = await seed("Quanto fa 1 diviso 0?");
    await open(chatId);
    await expect(page.locator(".ask-bar-name")).toHaveText("Quanto fa 1 diviso 0?");
    expect(await listed()).toEqual([]);
    await expect(page.getByRole("link", { name: /Quanto fa 1 diviso 0/ })).toHaveCount(0);

    // Left unsent, it is removed.
    await leave();
    await expect.poll(chatsInDatabase).toBe(0);

    // A composer that holds text keeps the chat, with or without a message.
    const kept = await seed("Un'altra domanda");
    await open(kept.chatId);
    await box.fill("Perché non si può?");
    await leave();
    // The removal runs when the page lets go, so give it the time to have happened before saying it did not.
    await page.waitForTimeout(1000);
    expect(chatsInDatabase()).toBe(1);

    // The first message lists the chat, under the same id.
    await open(kept.chatId);
    await expect(box).toHaveText("Perché non si può?");
    await box.press("Enter");
    await expect(page.getByText("Perché la divisione per zero non è definita.")).toBeVisible({ timeout: 30000 });
    expect(await listed()).toHaveLength(1);
    await expect(page.getByRole("link", { name: /Un'altra domanda/ })).toBeVisible();
    await leave();
    await page.waitForTimeout(1000);
    expect(chatsInDatabase()).toBe(1);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
