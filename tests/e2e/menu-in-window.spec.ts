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
/** Less room than this to the right of a point, and a menu, at least as wide, has to open on its left. */
const NARROW = 200;

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
  const view = page.viewportSize()!;
  const x = Math.min(box.x + box.width, view.width) - 12;
  const y = Math.min(box.y + box.height, view.height) - 8;
  // The point is on the item, near the corner: there is less room below it than any of these menus needs.
  expect(x).toBeGreaterThan(view.width - NARROW);
  expect(y).toBeGreaterThan(view.height - 120);
  await page.mouse.click(x, y, { button: "right" });
}

/**
 * Widens the window until the shelf's rightmost column of covers ends near its right edge, and returns the last cover of
 * that column. The shelf wraps its covers by its width, which the sidebar shares (it is wider on macOS), so at 960 px the
 * last column can end up to one cover's width before the shelf does.
 */
async function coverInCorner(page: Page, covers: Locator): Promise<number> {
  const layout = () =>
    covers.evaluateAll((nodes) => {
      const boxes = nodes.map((node) => node.getBoundingClientRect());
      const right = Math.max(...boxes.map((box) => box.right));
      const lefts = [...new Set(boxes.map((box) => Math.round(box.left)))].sort((a, b) => a - b);
      return {
        right,
        // The last cover whose right edge is the rightmost: the lowest of the rightmost column.
        index: boxes.map((box, index) => [box.right, index] as const).filter(([edge]) => edge === right).at(-1)![1],
        pitch: lefts[1]! - lefts[0]!,
        // Where the shelf's covers can end: its box without its padding.
        shelfEnd:
          nodes[0]!.parentElement!.getBoundingClientRect().right -
          parseFloat(getComputedStyle(nodes[0]!.parentElement!).paddingRight),
      };
    });
  const view = page.viewportSize()!;
  const found = await layout();
  if (view.width - (found.right - 12) >= NARROW) {
    // One more column fits once the shelf has grown by what it lacks for one.
    const width = view.width + Math.ceil(found.pitch - (found.shelfEnd - found.right));
    await page.setViewportSize({ width, height: view.height });
    await expect.poll(async () => (await layout()).right).toBeGreaterThan(found.right);
  }
  return (await layout()).index;
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
    // The lowest cover of the shelf's rightmost column, with that column at the window's right edge.
    const last = { index: await coverInCorner(page, covers) };
    await rightClickInCorner(page, covers.nth(last.index));
    await expectMenuInWindow(page, open);
    const confirmed = page.waitForEvent("dialog").then(async (dialog) => {
      const message = dialog.message();
      await dialog.dismiss();
      return message;
    });
    // The menu's own last item, by name: "Sposta in" draws its submenu inside the menu, and where the pointer comes to
    // rest on it after the right-click (the macOS layout), the last item counted would be the submenu's.
    await open.getByRole("menuitem", { name: "Rimuovi", exact: true }).click();
    expect(await confirmed).toMatch(/^Rimuovere «Dispensa \d\d»\?$/);

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
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
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

/** A map of Limiti with three branches, for the map page and its tiles. */
function limitsMap(id: string, title: string, instruction?: string) {
  const labels = ["Definizioni", "Teoremi", "Limiti notevoli"];
  const nodes = [
    { id: "n0", label: title, parent: null as string | null, x: 0, y: 0, pinned: false },
    ...labels.map((label, index) => ({ id: `b${index}`, label, parent: "n0", x: 0, y: 0, pinned: false })),
  ];
  const edges = labels.map((_, index) => ({ from: "n0", to: `b${index}` }));
  return { id, title, instruction, passageIds: [], grounding: "sources", graph: { layout: "tree", undo: null, redo: null, nodes, edges } };
}

/**
 * Sixteen subjects, so "Sposta in" is taller than the window; Analisi 1 with fourteen files, an exam whose topic Limiti
 * has four maps (a row of tiles that reaches the window's right edge), and a file without a subject in "Da sistemare".
 */
function seedSubmenus(db: DatabaseSync) {
  seed(db);
  seedSource(db, { id: "loose", title: "Appunti sciolti" });
  db.prepare("INSERT INTO maps(id,plan_id,topic_id,graph_json,grounding,created_at) VALUES(?,?,?,?,'sources',1)").run(
    "row-lim",
    "p-an",
    "t-lim",
    JSON.stringify({
      version: 1,
      maps: [
        limitsMap("m-lim", "Limiti"),
        limitsMap("m-teo", "Teoremi sui limiti", "solo i teoremi"),
        limitsMap("m-not", "Limiti notevoli", "solo i limiti notevoli"),
        limitsMap("m-es", "Esercizi sui limiti", "solo gli esercizi"),
      ],
    }),
  );
}

/**
 * The submenu that `row` opens lies beside the menu it grows from, never over it, so the row and its neighbours stay
 * readable, and inside the window.
 */
async function expectSubmenuBeside(page: Page, row: Locator, label: string) {
  // The menu has finished growing out of its dots, so the row stays under the pointer once it is there.
  await expect(row).toBeVisible();
  await animationsSettled(page);
  await row.hover();
  const sub = page.locator(".ant-dropdown-menu-sub:visible");
  await expect(sub.getByRole("menuitem").first()).toBeVisible();
  await animationsSettled(page);
  const parent = (await page.locator(".px-item-menu:not(.ant-dropdown-hidden) .ant-dropdown-menu-root").boundingBox())!;
  const box = (await sub.boundingBox())!;
  const viewport = page.viewportSize()!;
  const overlap =
    Math.min(box.x + box.width, parent.x + parent.width) - Math.max(box.x, parent.x) > 0.5 &&
    Math.min(box.y + box.height, parent.y + parent.height) - Math.max(box.y, parent.y) > 0.5;
  expect(overlap, `${label}: submenu ${JSON.stringify(box)} over its menu ${JSON.stringify(parent)}`).toBe(false);
  expect(box.x, `${label} left`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${label} top`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${label} right`).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height, `${label} bottom`).toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator(".px-item-menu:not(.ant-dropdown-hidden)")).toHaveCount(0);
}

for (const [width, height] of [
  [1280, 800],
  [960, 600],
] as const) {
  test(`A submenu opens beside its menu, never over it, at ${width} px`, async () => {
    test.setTimeout(120_000);
    const userData = mkdtempSync(join(tmpdir(), "pyxis-submenu-"));
    const app = await launchPyxis({ userData });
    try {
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "Salta" }).click();
      await fromChiediToExams(page);
      const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
      seedSubmenus(db);
      db.close();
      await page.setViewportSize({ width, height });
      const open = page.locator(".px-item-menu:not(.ant-dropdown-hidden)");
      const exportRow = () => open.getByRole("menuitem", { name: "Esporta", exact: true });

      // The map page: its dots sit at the window's right edge.
      await page.evaluate(() => {
        location.hash = "#/maps/s-an/t-lim";
      });
      await page.reload();
      await expect(page.locator(".react-flow__node")).toHaveCount(4);
      await page.locator(".px-map-actions").getByRole("button", { name: "Altro", exact: true }).click();
      await expectSubmenuBeside(page, exportRow(), "map dots");

      // A right-click near the canvas's right edge.
      const canvas = (await page.locator(".px-map-canvas").boundingBox())!;
      await page.mouse.click(canvas.x + canvas.width - 16, canvas.y + 16, { button: "right" });
      await expectSubmenuBeside(page, exportRow(), "map canvas");

      // The rightmost tile on Mappe.
      await page.evaluate(() => {
        location.hash = "#/maps";
      });
      const tiles = page.locator(".px-maps-tilew");
      await expect(tiles).toHaveCount(4);
      const rights = await tiles.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right));
      const tile = tiles.nth(rights.indexOf(Math.max(...rights)));
      await tile.hover();
      await tile.locator(".px-maps-dots").click();
      await expectSubmenuBeside(page, exportRow(), "map tile");

      // The Library: the rightmost cover of the shelf's first row, and the row in "Da sistemare".
      await page.evaluate(() => {
        location.hash = "#/exams/library";
      });
      const covers = page.locator(".px-cover");
      await expect(covers).toHaveCount(14);
      const coverRights = await covers.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right));
      const cover = covers.nth(coverRights.indexOf(Math.max(...coverRights)));
      const title = (await cover.locator(".px-cover-title").textContent())!;
      await cover.hover();
      await cover.getByRole("button", { name: `Azioni per ${title}` }).click();
      const moveRow = () => open.getByRole("menuitem", { name: "Sposta in", exact: true });
      await expectSubmenuBeside(page, moveRow(), "cover");

      const loose = page.getByRole("region", { name: "Da sistemare" }).locator(".px-unsorted-row", { hasText: "Appunti sciolti" });
      await loose.hover();
      await loose.getByRole("button", { name: "Azioni per Appunti sciolti" }).click();
      await expectSubmenuBeside(page, moveRow(), "Da sistemare");
    } finally {
      await app.close();
      removeTestFolder(userData);
    }
  });
}

test("In a window too narrow for a submenu on either side, the submenu leaves the item that opened it in sight", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-submenu-narrow-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seedSubmenus(db);
    db.close();
    await page.evaluate(() => {
      location.hash = "#/maps/s-an/t-lim";
    });
    await page.reload();
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    // 440 px: the menu opens at x 200, and neither the 200 px on its left nor the room on its right holds its formats.
    await page.setViewportSize({ width: 440, height: 600 });
    await page.locator(".px-map-canvas").dispatchEvent("contextmenu", { clientX: 200, clientY: 120, button: 2 });
    const open = page.locator(".px-item-menu:not(.ant-dropdown-hidden)");
    const row = open.getByRole("menuitem", { name: "Esporta", exact: true });
    await expect(row).toBeVisible();
    await animationsSettled(page);
    await row.hover();
    const sub = page.locator(".ant-dropdown-menu-sub:visible");
    await expect(sub.getByRole("menuitem").first()).toBeVisible();
    await animationsSettled(page);
    // The card is moved after the trigger places it, so wait for it to stop moving.
    await expect
      .poll(async () => {
        const opener = (await row.boundingBox())!;
        const box = (await sub.boundingBox())!;
        return box.y >= opener.y + opener.height || box.y + box.height <= opener.y;
      })
      .toBe(true);
    const box = (await sub.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(440);
    expect(box.y + box.height).toBeLessThanOrEqual(600);
    // Its formats still act.
    await expect(sub.getByRole("menuitem", { name: /^Schema in testo/ })).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("A submenu taller than a narrow window holds still, stays inside the window and every item can be reached", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-submenu-tall-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seedSubmenus(db);
    // Twenty subjects with long names: "Sposta in" lists them all, far taller than the window and wider than its room.
    seedSubjects(
      db,
      Array.from({ length: 20 }, (_, index) => ({
        id: `long-${index}`,
        name: `Fondamenti di analisi matematica e geometria, modulo ${String(index + 1).padStart(2, "0")}`,
      })),
    );
    db.close();
    await page.evaluate(() => {
      location.hash = "#/exams/library";
    });
    await page.reload();
    await page.setViewportSize({ width: 440, height: 600 });
    const loose = page.getByRole("region", { name: "Da sistemare" }).locator(".px-unsorted-row", { hasText: "Appunti sciolti" });
    await loose.hover();
    await loose.getByRole("button", { name: "Azioni per Appunti sciolti" }).click();
    const open = page.locator(".px-item-menu:not(.ant-dropdown-hidden)");
    const row = open.getByRole("menuitem", { name: "Sposta in", exact: true });
    await expect(row).toBeVisible();
    await animationsSettled(page);
    await row.hover();
    const sub = page.locator(".ant-dropdown-menu-sub:visible");
    await expect(sub.getByRole("menuitem").first()).toBeVisible();
    await animationsSettled(page);
    // Thirty frames, one box each: the same box every time, with the submenu's entries all in it.
    const frames = await sub.evaluate(
      (node) =>
        new Promise<Array<{ x: number; y: number; width: number; height: number }>>((resolve) => {
          const seen: Array<{ x: number; y: number; width: number; height: number }> = [];
          const sample = () => {
            const { x, y, width, height } = node.getBoundingClientRect();
            seen.push({ x, y, width, height });
            if (seen.length < 30) requestAnimationFrame(sample);
            else resolve(seen);
          };
          requestAnimationFrame(sample);
        }),
    );
    expect(frames).toHaveLength(30);
    for (const [index, frame] of frames.entries()) expect(frame, `frame ${index}`).toEqual(frames[0]);
    const viewport = page.viewportSize()!;
    const box = frames[0]!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    // It is taller than the window would let it be, so it scrolls inside itself and its entries are all reachable.
    const items = sub.getByRole("menuitem");
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(21);
    const inView = async (index: number) => {
      const item = (await items.nth(index).boundingBox())!;
      const card = (await sub.boundingBox())!;
      return item.y >= card.y - 0.5 && item.y + item.height <= card.y + card.height + 0.5;
    };
    await items.last().scrollIntoViewIfNeeded();
    expect(await inView(count - 1), "last item after scrolling").toBe(true);
    await items.first().scrollIntoViewIfNeeded();
    expect(await inView(0), "first item after scrolling back").toBe(true);
    // The arrow keys walk through all of them, each one in sight when it has the focus.
    const names = await items.allInnerTexts();
    await items.first().focus();
    const focused = () => page.evaluate(() => document.activeElement?.textContent ?? "");
    const reached = new Set<string>([await focused()]);
    let before = await focused();
    for (let index = 1; index < count; index++) {
      await page.keyboard.press("ArrowDown");
      // The menu moves the focus a moment after the key.
      await expect.poll(focused, { message: `after ${before}` }).not.toBe(before);
      const seen = await page.evaluate(() => {
        const active = document.activeElement!;
        const item = active.getBoundingClientRect();
        const card = active.closest("ul")!.getBoundingClientRect();
        return {
          text: active.textContent ?? "",
          inCard: item.top >= card.top - 0.5 && item.bottom <= card.bottom + 0.5,
          inWindow: item.top >= 0 && item.bottom <= innerHeight,
        };
      });
      before = seen.text;
      reached.add(seen.text);
      expect(seen.inCard, `${seen.text} in its card`).toBe(true);
      expect(seen.inWindow, `${seen.text} in the window`).toBe(true);
    }
    expect([...reached].sort()).toEqual([...names].sort());
    // And the box has not moved while they did.
    const after = (await sub.boundingBox())!;
    expect(after).toEqual(box);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
