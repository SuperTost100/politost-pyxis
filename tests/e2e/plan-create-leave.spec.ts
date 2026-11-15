import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis, setUp } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedSource } from "./seed";

/**
 * A new exam is created by a request that can still be on its way when the student leaves the form (the leave question,
 * answered with "Esci senza salvare"). The exam is made either way; the form, which is gone, must not move the window.
 */

const replies = {
  modules: { modules: [{ title: "Cinematica", summary: "Il moto dei corpi" }, { title: "Dinamica", summary: "Le forze" }] },
  topics: { topics: [{ title: "Cinematica del punto", summary: "Moto", subtopics: ["Velocità"] }, { title: "Dinamica", summary: "Forze", subtopics: [] }] },
};

/** The app with the creation held back for a few seconds, a book in the library and the new exam's form open. */
async function start() {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-create-leave-"));
  const app = await launchPyxis({
    userData,
    env: { PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies), PYXIS_E2E_READ_DELAY: "plans.create=2500" },
  });
  return setUp(app, userData, async () => {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    try {
      seedSource(db, {
        id: "book",
        title: "Bramanti, Pagani, Salsa",
        document: { id: "doc" },
        passages: [{ id: "ps", text: "La velocità è lo spazio diviso il tempo.", locator: { chapter: 1 }, section: "1. Cinematica" }],
      });
    } finally {
      db.close();
    }
    await page.reload();
    await page.evaluate(() => {
      location.hash = "/plans/new";
    });
    await page.getByRole("textbox", { name: "Nome dell'esame", exact: true }).fill("Fisica generale");
    await page.getByRole("button", { name: "Non ho ancora la data" }).click();
    return { app, page, userData };
  });
}

/** Waits for the exam the held request makes, and for the page to have handled its answer. */
async function examIsMade(page: Page) {
  await expect.poll(() => page.evaluate(() => window.pyxis.invoke("plans.list", {}).then((plans) => plans.length))).toBe(1);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
}

test("an exam made from the guided flow after the student left it does not take them back to its build", async () => {
  test.setTimeout(120_000);
  const { app, page, userData } = await start();
  try {
    for (let i = 0; i < 2; i++) await page.getByRole("button", { name: "Continua", exact: true }).click();
    await page.getByRole("group", { name: "Periodo" }).getByRole("button").first().click();
    await page.getByRole("button", { name: "Continua", exact: true }).click();
    await page.getByLabel("Cinematica", { exact: true }).check();
    for (let i = 0; i < 2; i++) await page.getByRole("button", { name: "Continua", exact: true }).click();
    await page.getByRole("button", { name: "Crea l'esame" }).click();
    // Back, to the form with its answers, while the exam is being made.
    await page.getByRole("button", { name: /^Torna a / }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Da cosa studi?" })).toBeVisible();
    await examIsMade(page);
    await expect(page).toHaveURL(/#\/plans\/new$/);
    await expect(page.getByRole("heading", { level: 2, name: "Da cosa studi?" })).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
