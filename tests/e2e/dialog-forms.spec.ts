import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedSubjects } from "./seed";
import { animationsSettled } from "./settled";

test("DIALOG-03 a form's select opens above the dialog, is reached by keyboard, and Escape closes it before the dialog", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-dialog-forms-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    // Enough subjects that the list reaches past the dialog's bottom edge in a short window.
    seedSubjects(
      db,
      ["Analisi", "Chimica", "Fisica I", "Fisica II", "Geometria", "Informatica", "Statistica"].map((name) => ({
        id: name.toLowerCase().replace(/\s/g, "-"),
        name,
      })),
    );
    db.close();
    await page.reload();
    await page.setViewportSize({ width: 960, height: 640 });
    await page.getByText("Mappe", { exact: true }).click();
    const opener = page.getByRole("button", { name: "Nuova mappa" });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Nuova mappa" });
    await expect(dialog).toBeVisible();
    await animationsSettled(page);

    // The first field has the focus; ArrowDown opens its list.
    const subject = dialog.getByLabel("Materia");
    await expect(subject).toBeFocused();
    await page.keyboard.press("ArrowDown");
    const list = dialog.locator(".ant-select-dropdown:visible");
    await expect(list, "the list is drawn inside the dialog, so it sits above it").toBeVisible();
    // Its last option reaches past the dialog's bottom edge, and can be hit where it is drawn: nothing clips it.
    const last = list.locator(".ant-select-item-option").last();
    // The list scrolls inside itself, so the last option is brought into its view first.
    await last.scrollIntoViewIfNeeded();
    const reachable = await last.evaluate((option) => {
      const box = option.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { hit: hit !== null && option.contains(hit), inside: box.bottom <= innerHeight && box.top >= 0 };
    });
    expect(reachable).toEqual({ hit: true, inside: true });

    // Escape closes the list, and the dialog stays with its field.
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(subject).toBeFocused();

    // The keyboard picks an option, and the dialog stays.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(dialog.locator(".ant-select").first()).toContainText("Chimica");
    await expect(dialog).toBeVisible();
    // The list has shut after the pick; an Escape before that is still the list's.
    await expect(list).toBeHidden();
    await expect(subject).toHaveAttribute("aria-expanded", "false");

    // A second Escape closes the dialog and the focus goes back to the button it grew out of.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("DIALOG-04 a .pyxis file picked on Esami is reviewed in the one dialog: Annulla, a click outside that stays, and Importa", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-dialog-import-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const file = {
      name: "Fisica prestata.pyxis",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          version: 2,
          id: "plan-fisica-prestata",
          createdAt: 1_760_000_000_000,
          title: "Fisica prestata",
          topics: [{ id: "t", title: "Moti", position: 0 }],
          nodes: [],
          cards: [{ front: "$v$", back: "Velocità", topic: 0 }],
        }),
      ),
    };
    const input = page.locator('input[type="file"]').first();
    await input.setInputFiles(file);
    const dialog = page.getByRole("dialog", { name: "Importa un esame" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Fisica prestata" })).toBeVisible();
    // The buttons are the dialog's own, and it has no X beside Annulla.
    await expect(dialog.getByRole("button", { name: "Annulla" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Importa", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Chiudi" })).toHaveCount(0);
    await animationsSettled(page);

    // A click outside would throw the choices away, so it leaves the dialog open; Annulla closes it.
    await page.mouse.click(4, 4);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Annulla" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.pyxis.invoke("plans.list", {}))).toHaveLength(0);

    await input.setInputFiles(file);
    await expect(dialog).toBeVisible();
    await animationsSettled(page);
    await dialog.getByRole("button", { name: "Importa", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const titles = await page.evaluate(async () =>
      (await window.pyxis.invoke("plans.list", {})).map((plan: { title: string }) => plan.title),
    );
    expect(titles).toEqual(["Fisica prestata"]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("DIALOG-05 a form opened from a menu item gives the focus back to the menu's button, as the item it was chosen from is gone", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-dialog-menu-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const dots = page.getByRole("button", { name: "Altro su Esami", exact: true });
    const dialog = page.getByRole("dialog", { name: "Gestisci materie" });
    for (const way of ["Chiudi", "Escape"] as const) {
      await dots.click();
      await page.getByRole("menuitem", { name: "Gestisci materie" }).click();
      await expect(dialog).toBeVisible();
      // The item it was chosen from is gone by the time it closes, so the focus goes to the dots.
      await animationsSettled(page);
      if (way === "Escape") await page.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: "Chiudi" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(dots).toBeFocused();
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
