import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedPlan, seedSource } from "./seed";

/**
 * Indietro and Avanti, from the menu, the mouse's side buttons and the swipe, must not drop an answer typed into a
 * page that keeps it only in the window: they stay refused, as every other menu command does, until the page saves.
 */

const practice = /#\/plans\/p-ex\/practice\/t-ex$/;

async function pick(app: ElectronApplication, id: string) {
  const found = await app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    item?.click();
    return Boolean(item);
  }, id);
  expect(found, `menu item ${id}`).toBe(true);
}

test("typing an answer on the exercises page keeps Indietro and Avanti from leaving it", async () => {
  test.setTimeout(90_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-leave-typing-"));
  const app = await launchPyxis({ userData });
  try {
    const page: Page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    try {
      seedSource(db, {
        id: "src-ex",
        title: "Appunti di fisica",
        document: { id: "doc-ex" },
        passages: [{ id: "ps-ex", text: "La forza è massa per accelerazione.", locator: { chapter: 1, paragraph: "p1" }, section: "1. Dinamica" }],
      });
      seedPlan(db, { id: "p-ex", title: "Fisica 1", language: "it", target: 0.75, sourceIds: ["src-ex"], topics: [{ id: "t-ex", title: "Dinamica" }] });
      db.exec(`INSERT INTO topic_passages(topic_id,passage_id) VALUES('t-ex','ps-ex');
        INSERT INTO smartbooks(id,source_id,meta_json,created_at) VALUES('b-ex','src-ex','{"title":"Fisica","chapters":[]}',1);
        INSERT INTO exercises(id,smartbook_id,passage_id,prompt,answer,locator_json,grounding,created_at)
          VALUES('x-ex','b-ex','ps-ex','Calcola la forza per m=2 kg e a=3 m/s2.','F=ma=6 N','{"chapter":1,"kind":"esame"}','sources',1);`);
    } finally {
      db.close();
    }
    await page.reload();
    await page.evaluate(() => {
      location.hash = "/plans/p-ex";
    });
    await expect(page.getByRole("heading", { level: 1, name: "Fisica 1" })).toBeVisible();
    // The exercises page, opened from the exam, so it has a page behind it to go back to.
    await page.evaluate(() => {
      location.hash = "/plans/p-ex/practice/t-ex";
    });
    const answer = page.getByRole("textbox", { name: "La tua risposta" });
    await expect(answer).toBeVisible();
    await answer.click();
    await page.keyboard.type("F = 6 N");
    await expect(answer).toContainText("F = 6 N");

    const swipe = () =>
      app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.emit("swipe", {}, "left");
      });
    const mouse = () =>
      page.evaluate(() => window.dispatchEvent(new MouseEvent("mouseup", { button: 3, bubbles: true, cancelable: true })));
    for (const way of [() => pick(app, "back"), swipe, mouse]) {
      await way();
      // A fixed wait on purpose: nothing signals that a command was ignored.
      await page.waitForTimeout(400);
      await expect(page).toHaveURL(practice);
      await expect(answer).toContainText("F = 6 N");
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
