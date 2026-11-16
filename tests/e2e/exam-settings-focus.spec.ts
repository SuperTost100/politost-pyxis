import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis, setUp } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedPlan } from "./seed";

/**
 * The exam's settings as "Imposta obiettivo di studio" opens them (`focus: "hours"` in the entry's state), with the
 * planner's read held back: the weekly hours stay off until it arrives, and what the student does meanwhile is theirs.
 */
async function openedAtHours(held: number) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-settings-focus-"));
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_READ_DELAY: `plans.planner=${held}` } });
  // A step that fails here closes the app and removes the profile, as the caller never gets them to do it.
  const page = await setUp(app, userData, async () => {
    const page: Page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    try {
      seedPlan(db, { id: "plan-a", title: "Fisica 1", language: "it", topics: [{ id: "topic-a", title: "Cinematica" }] });
    } finally {
      db.close();
    }
    // An entry with a key of its own and the state the Oggi action leaves, read again from the start: nothing is cached.
    await page.evaluate(() => {
      history.pushState({ key: "hours-entry", idx: 99, usr: { focus: "hours" } }, "", "#/plans/plan-a/settings");
    });
    await page.reload();
    return page;
  });
  return { app, page, userData };
}

test("typing in another field while the planner is read keeps the text and the focus there when the hours arrive", async () => {
  const { app, page, userData } = await openedAtHours(2500);
  try {
    const name = page.getByLabel("Nome dell'esame");
    const hours = page.getByRole("spinbutton", { name: "Ore a settimana" });
    await expect(name).toBeVisible();
    await expect(hours).toBeDisabled();
    await name.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("Fisica ");
    // The planner arrives and the hours can be used: the focus stays where the student put it.
    await expect(hours).toBeEnabled({ timeout: 10_000 });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await expect(name).toBeFocused();
    await page.keyboard.type("generale");
    await expect(name).toHaveValue("Fisica generale");
    await expect(hours).toHaveValue("");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("with the focus nowhere, the hours take it once the planner has been read", async () => {
  const { app, page, userData } = await openedAtHours(1500);
  try {
    const hours = page.getByRole("spinbutton", { name: "Ore a settimana" });
    await expect(page.getByLabel("Nome dell'esame")).toBeVisible();
    await expect(hours).toBeDisabled();
    await expect(hours).toBeEnabled({ timeout: 10_000 });
    await expect(hours).toBeFocused();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
