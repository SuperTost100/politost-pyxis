import type { Locator, Page } from "@playwright/test";

/**
 * Keeps the last events that can end a menu or move the focus (scrolls, resizes, focus moves, key presses and presses
 * of the pointer), with the time each came, so a spec that finds a menu gone can say what happened to it. It changes
 * nothing on the page. The trail is lost when the page reloads.
 */
export async function trackEvents(page: Page) {
  await page.evaluate(() => {
    const trail: string[] = [];
    const named = (node: EventTarget | null) =>
      node instanceof Element ? `${node.tagName.toLowerCase()}.${String(node.className).split(" ")[0]}` : node === document ? "document" : "window";
    const note = (text: string) => {
      trail.push(`${Math.round(performance.now())}ms ${text}`);
      if (trail.length > 40) trail.shift();
    };
    addEventListener("scroll", (event) => note(`scroll ${named(event.target)} y=${scrollY}`), true);
    addEventListener("resize", () => note(`resize ${innerWidth}x${innerHeight}`), true);
    addEventListener("focusin", (event) => note(`focus ${named(event.target)}`), true);
    addEventListener("keydown", (event) => note(`key ${event.key} on ${named(event.target)}`), true);
    addEventListener("pointerdown", (event) => note(`pointer down on ${named(event.target)}`), true);
    (window as unknown as { __eventTrail: () => string }).__eventTrail = () => {
      const menus = [...document.querySelectorAll(".ant-dropdown")].map((menu) => (menu.classList.contains("ant-dropdown-hidden") ? "hidden" : "shown"));
      const expanded = document.querySelectorAll('[aria-expanded="true"]').length;
      return [
        `${Math.round(performance.now())}ms now: scrollY=${scrollY}, ${innerWidth}x${innerHeight}, focus in ${named(document.activeElement)},`,
        `${menus.length} dropdowns in the page (${menus.join(", ") || "none"}), ${expanded} buttons with aria-expanded=true.`,
        "Last events:",
        ...trail,
      ].join("\n");
    };
  });
}

/**
 * The box of a menu that is open. When the menu is gone, the error says what the page did in its last moments, which
 * tells a scroll or a resize that closed it from a menu the app took away.
 */
export async function openBox(menu: Locator, page: Page, what: string) {
  if ((await menu.count()) === 0) {
    const trail = await page.evaluate(() => (window as unknown as { __eventTrail?: () => string }).__eventTrail?.() ?? "No event trail.");
    throw new Error(`${what} is not in the page any more.\n${trail}`);
  }
  return (await menu.boundingBox())!;
}

/** Runs a check and, when it fails, adds what the page did in its last moments to the error. */
export async function withTrail(page: Page, check: () => Promise<void>) {
  try {
    await check();
  } catch (error) {
    const trail = await page.evaluate(() => (window as unknown as { __eventTrail?: () => string }).__eventTrail?.() ?? "No event trail.");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${trail}`, { cause: error });
  }
}
