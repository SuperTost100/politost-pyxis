import { expect, type Locator, type Page } from "@playwright/test";

/**
 * What every empty page has in common: one line of text in the muted colour, at most 60ch wide, starting at the left
 * edge of the page's title, with no heading and no more than the one button. `action` names that button; without it
 * the page has none. The button shows once on the page, so the head's own copy of it is hidden.
 */
export async function expectEmptyPage(page: Page, { line, action }: { line: RegExp; action?: string }) {
  const empty = page.locator(".px-empty");
  await expect(empty).toHaveCount(1);
  await expect(empty.getByRole("heading")).toHaveCount(0);
  const text = empty.locator("p");
  await expect(text).toHaveCount(1);
  await expect(text).toHaveText(line);
  if (action) {
    await expect(empty.getByRole("button")).toHaveText([action]);
    await expect(page.getByRole("main").getByRole("button", { name: action, exact: true })).toHaveCount(1);
  } else await expect(empty.getByRole("button")).toHaveCount(0);

  const box = (await text.boundingBox())!;
  const maxWidth = await text.evaluate((node) => parseFloat(getComputedStyle(node).maxWidth));
  expect(box.width, "the line is at most 60ch wide").toBeLessThanOrEqual(maxWidth + 0.5);
  const title = (await page.getByRole("main").getByRole("heading", { level: 1 }).boundingBox())!;
  expect(Math.abs(box.x - title.x), "the line starts where the title starts").toBeLessThanOrEqual(1);
  if (action) {
    const button = (await empty.getByRole("button").boundingBox())!;
    expect(Math.abs(button.x - title.x), "the button starts where the title starts").toBeLessThanOrEqual(1);
    expect(button.x + button.width, "the button is not clipped").toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  // The line wraps inside the page: nothing makes the page scroll sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

/** The place and size of a page's head, to show that nothing in it jumps when the empty page gives way. */
export async function headBox(head: Locator) {
  const box = (await head.boundingBox())!;
  return { y: Math.round(box.y), height: Math.round(box.height) };
}
