import { expect, type Locator, type Page } from "@playwright/test";

/**
 * What every empty page has in common: one line of text in the muted colour, with no heading and no more than the one
 * button, and the block in the middle of the room under the page's head (`expectCentred`). `action` names that button;
 * without it the page has none. The button shows once on the page, so the head's own copy of it is hidden. `art` says
 * whether the page has a drawing above the line, which is hidden from screen readers. `small` is the block of a page that
 * has other content (every exam archived, a Library with subjects): left-aligned under the head, at most 60ch wide, with
 * no drawing.
 */
export async function expectEmptyPage(
  page: Page,
  { line, action, art = false, small = false }: { line: RegExp; action?: string; art?: boolean; small?: boolean },
) {
  const empty = page.locator(".px-empty");
  await expect(empty).toHaveCount(1);
  await expect(empty.getByRole("heading")).toHaveCount(0);
  const text = empty.locator("p");
  await expect(text).toHaveCount(1);
  await expect(text).toHaveText(line);
  await expect(empty.locator(".px-empty-art")).toHaveCount(art && !small ? 1 : 0);
  if (art && !small) await expect(empty.locator(".px-empty-art[aria-hidden='true'] svg[aria-hidden='true']")).toHaveCount(1);
  if (action) {
    await expect(empty.getByRole("button")).toHaveText([action]);
    await expect(page.getByRole("main").getByRole("button", { name: action, exact: true })).toHaveCount(1);
  } else await expect(empty.getByRole("button")).toHaveCount(0);

  const box = (await text.boundingBox())!;
  const maxWidth = await text.evaluate((node) => parseFloat(getComputedStyle(node).maxWidth));
  if (small) expect(box.width, "the line is at most 60ch wide").toBeLessThanOrEqual(maxWidth + 0.5);
  else expect(box.width, "the line is at most 460px wide").toBeLessThanOrEqual(460.5);
  if (small) {
    const title = (await page.getByRole("main").getByRole("heading", { level: 1 }).boundingBox())!;
    expect(Math.abs(box.x - title.x), "the line starts where the title starts").toBeLessThanOrEqual(1);
    if (action) {
      const button = (await empty.getByRole("button").boundingBox())!;
      expect(Math.abs(button.x - title.x), "the button starts where the title starts").toBeLessThanOrEqual(1);
    }
  } else await expectCentred(page);
  if (action) {
    const button = (await empty.getByRole("button").boundingBox())!;
    expect(button.x + button.width, "the button is not clipped").toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  // The line wraps inside the page: nothing makes the page scroll sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

/**
 * Where the empty block sits: its drawing, line and button, taken together, are centred across the page column and down
 * the room that runs from under the page's head to the window's bottom edge, to within 3px. In a window too short for
 * the block, the room grows with it: the block then sits under the head, clear of it, and the page scrolls. The page is
 * not taller than the window otherwise, so it shows no scrollbar of its own.
 */
export async function expectCentred(page: Page) {
  await expect(page.locator(".px-empty")).toBeVisible();
  const found = await page.evaluate(() => {
    const empty = document.querySelector<HTMLElement>(".px-empty")!;
    const rect = (node: Element) => node.getBoundingClientRect();
    // What is drawn: the drawing, the words (not the line's box, which may be wider than they are) and the button.
    const words = document.createRange();
    words.selectNodeContents(empty.querySelector("p")!);
    const parts = [
      ...[...empty.querySelectorAll(".px-empty-art svg, button")].map(rect),
      words.getBoundingClientRect(),
    ];
    const block = {
      left: Math.min(...parts.map((part) => part.left)),
      right: Math.max(...parts.map((part) => part.right)),
      top: Math.min(...parts.map((part) => part.top)),
      bottom: Math.max(...parts.map((part) => part.bottom)),
    };
    const room = rect(empty);
    const column = rect(document.querySelector(".shell-page")!);
    const before = empty.previousElementSibling ? rect(empty.previousElementSibling) : null;
    return {
      block,
      room: { top: room.top, bottom: room.bottom },
      column: { left: column.left, right: column.right },
      headBottom: before?.bottom ?? null,
      overflow: document.documentElement.scrollHeight - window.innerHeight,
      innerHeight: window.innerHeight,
    };
  });
  const { block, room, column } = found;
  expect(Math.abs((block.left + block.right) / 2 - (column.left + column.right) / 2), "centred across the page").toBeLessThanOrEqual(3);
  if (found.headBottom !== null) expect(block.top, "clear of the head").toBeGreaterThanOrEqual(found.headBottom);
  if (found.overflow <= 0) {
    // The room runs from under the head to the window's bottom edge, whatever the block's own box is.
    expect(Math.abs((block.top + block.bottom) / 2 - (room.top + found.innerHeight) / 2), "centred down the room under the head").toBeLessThanOrEqual(3);
  } else {
    // Too short for the block: the page scrolls and the block keeps a gap under the head and above the page's end.
    expect(block.top - (found.headBottom ?? 0), "a gap under the head").toBeGreaterThanOrEqual(16);
    expect(room.bottom - block.bottom, "a gap under the block").toBeGreaterThanOrEqual(16);
  }
}

/** The place and size of a page's head, to show that nothing in it jumps when the empty page gives way. */
export async function headBox(head: Locator) {
  const box = (await head.boundingBox())!;
  return { y: Math.round(box.y), height: Math.round(box.height) };
}
