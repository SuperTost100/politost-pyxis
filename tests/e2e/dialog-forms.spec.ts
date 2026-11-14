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

    // A second Escape closes the dialog and the focus goes back to the button it grew out of.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
