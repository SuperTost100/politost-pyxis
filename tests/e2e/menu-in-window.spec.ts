import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { animationsSettled } from "./settled";

const WIDTH = 960;
const HEIGHT = 600;

/**
 * Sixteen subjects, so "Sposta in" is taller than the window; the first has enough files to fill rows of covers, and an
 * exam with enough cards to scroll the flashcard page.
 */
function seed(db: DatabaseSync) {
  seedSubjects(db, [
    { id: "s-an", name: "Analisi 1" },
    ...Array.from({ length: 15 }, (_, index) => ({
      id: `s-${index + 2}`,
      name: `Materia ${String(index + 2).padStart(2, "0")}`,
    })),
  ]);
  for (let index = 0; index < 14; index++)
    seedSource(db, {
      id: `src-${index}`,
      title: `Dispensa ${String(index + 1).padStart(2, "0")}`,
      subjectId: "s-an",
    });
  seedPlan(db, {
    id: "p-an",
    subjectId: "s-an",
    title: "Analisi 1",
    language: "it",
    topics: [{ id: "t-lim", title: "Limiti" }],
  });
  const insert = db.prepare(
    "INSERT INTO cards(id,plan_id,topic_id,front,back,seed_key,grounding,created_at) VALUES(?,?,?,?,?,?,?,?)",
  );
  for (let index = 0; index < 14; index++)
    insert.run(
      `c-${index}`,
      "p-an",
      "t-lim",
      `Domanda ${index + 1}`,
      `Risposta ${index + 1}`,
      `k${index}`,
      "sources",
      index,
    );
}

/** Every item of the open menu lies inside the window once it has finished opening. */
async function expectMenuInWindow(page: Page, menu: Locator) {
  const items = menu.getByRole("menuitem");
  await expect(items.first()).toBeVisible();
  await animationsSettled(page);
  const boxes = await items.evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return {
        text: node.textContent,
        top: box.top,
        left: box.left,
        bottom: box.bottom,
        right: box.right,
      };
    }),
  );
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  for (const box of boxes) {
    expect(box.top, `${box.text} top`).toBeGreaterThanOrEqual(0);
    expect(box.left, `${box.text} left`).toBeGreaterThanOrEqual(0);
    expect(box.bottom, `${box.text} bottom`).toBeLessThanOrEqual(
      viewport.height,
    );
    expect(box.right, `${box.text} right`).toBeLessThanOrEqual(viewport.width);
  }
}

/** Puts `item` at the window's bottom edge and right-clicks it near the window's bottom-right corner. */
async function rightClickInCorner(page: Page, item: Locator) {
  await item.evaluate((node) => node.scrollIntoView({ block: "end" }));
  const box = (await item.boundingBox())!;
  const x = Math.min(box.x + box.width, WIDTH) - 12;
  const y = Math.min(box.y + box.height, HEIGHT) - 8;
  // The point is on the item, near the corner: there is less room below it than any of these menus needs.
  expect(x).toBeGreaterThan(WIDTH - 200);
  expect(y).toBeGreaterThan(HEIGHT - 120);
  await page.mouse.click(x, y, { button: "right" });
}

test("A right-click menu near the window's bottom-right corner opens inside the window and its last item acts", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-menu-in-window-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10_000,
    });
    seed(db);
    db.close();
    await page.setViewportSize({ width: WIDTH, height: HEIGHT });
    await page.evaluate(() =>
      window.pyxis.invoke("profile.save", { dyslexia: false, textSize: "lg" }),
    );
    const open = page.locator(".px-item-menu:not(.ant-dropdown-hidden)");

    // A flashcard's row: its last item, Elimina, asks to confirm.
    await page.evaluate(() => {
      location.hash = "#/exams/cards";
    });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-text", "lg");
    const rows = page.locator(".px-cardbrowser-row");
    await expect(rows).toHaveCount(14);
    await rightClickInCorner(page, rows.nth(10));
    await expectMenuInWindow(page, open);
    await open.getByRole("menuitem").last().click();
    await expect(
      page.getByRole("dialog", { name: "Eliminare questa flashcard?" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // A Library cover: its last item, Rimuovi, asks to confirm.
    await page.evaluate(() => {
      location.hash = "#/exams/library";
    });
    await page.reload();
    const covers = page.locator(".px-cover");
    await expect(covers).toHaveCount(14);
    // The rightmost cover of the shelf's last row.
    const rights = await covers.evaluateAll((nodes) =>
      nodes
        .map((node) => node.getBoundingClientRect())
        .map((box) => [box.top, box.right]),
    );
    const rowTops = [...new Set(rights.map(([top]) => Math.round(top!)))].sort(
      (a, b) => a - b,
    );
    const lastRow = rights
      .map(([top, right], index) => ({
        top: Math.round(top!),
        right: right!,
        index,
      }))
      .filter((entry) => entry.top === rowTops.at(-1));
    const last = lastRow.reduce((a, b) => (b.right > a.right ? b : a));
    await rightClickInCorner(page, covers.nth(last.index));
    await expectMenuInWindow(page, open);
    const confirmed = page.waitForEvent("dialog").then(async (dialog) => {
      const message = dialog.message();
      await dialog.dismiss();
      return message;
    });
    await open.getByRole("menuitem").last().click();
    expect(await confirmed).toMatch(/^Rimuovi "Dispensa \d\d"\?$/);

    // The same cover's dots open the menu inside the window. "Sposta in", taller than the window, opens inside it too and
    // scrolls inside itself, and the menu it grows from stays where it was.
    const file = covers.nth(last.index);
    const title = (await file.locator(".px-cover-title").textContent())!;
    await file.evaluate((node) => node.scrollIntoView({ block: "end" }));
    await file.hover();
    await file.getByRole("button", { name: `Azioni per ${title}` }).click();
    await expectMenuInWindow(page, open);
    const root = page.locator(".ant-dropdown-menu-root:visible");
    const before = await root.boundingBox();
    await page
      .getByRole("menuitem", { name: "Sposta in", exact: true })
      .hover();
    const sub = page.locator(".ant-dropdown-menu-sub:visible");
    await expect(
      sub.getByRole("menuitem", { name: "Materia 16", exact: true }),
    ).toBeAttached();
    await animationsSettled(page);
    const box = (await sub.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(HEIGHT);
    expect(box.x + box.width).toBeLessThanOrEqual(WIDTH);
    expect(
      await sub.evaluate((list) => list.scrollHeight > list.clientHeight),
    ).toBe(true);
    expect(await root.boundingBox()).toEqual(before);
    await sub
      .getByRole("menuitem", { name: "Materia 16", exact: true })
      .click();
    await expect(
      page
        .getByRole("region", { name: "Materia 16 1 file" })
        .locator(".px-cover", { hasText: title }),
    ).toBeVisible();

    // The menu key on a cover at the bottom edge opens the menu inside the window too.
    const low = covers.nth(last.index - 1);
    await low.evaluate((node) => node.scrollIntoView({ block: "end" }));
    await low.locator(".px-cover-open").focus();
    await page.keyboard.press("Shift+F10");
    await expectMenuInWindow(page, open);
    await page.keyboard.press("Escape");
    await expect(low.locator(".px-cover-open")).toBeFocused();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
