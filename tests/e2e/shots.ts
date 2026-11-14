import type { Locator, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The folder for screenshots kept for review, from PYXIS_SHOTS (`PYXIS_SHOTS=.shots` gives the usual layout). Unset,
 * as in CI, the specs write none.
 */
export const SHOTS = process.env.PYXIS_SHOTS;

/** Saves a screenshot of the page or element as `name` under PYXIS_SHOTS, when it is set. */
export async function saveShot(
  target: Page | Locator,
  name: string,
  options: Omit<NonNullable<Parameters<Page["screenshot"]>[0]>, "path"> = {},
) {
  if (!SHOTS) {
    // A capture with animations disabled also ends the running ones, and the steps after it can rely on that. With no
    // picture to keep, only that part is done: a capture nobody looks at can still fail by itself ("Unable to capture
    // screenshot" right after the window changed size), and it failed two CI runs that way.
    if (options.animations === "disabled") await endAnimations("page" in target ? target.page() : target);
    return;
  }
  const path = join(SHOTS, name);
  mkdirSync(dirname(path), { recursive: true });
  await target.screenshot({ ...options, path });
}

/**
 * Ends the animations and transitions that have an end, as a capture with `animations: "disabled"` does, so each fires
 * its `transitionend` or `animationend`. One that never ends (a spinner) is left running: after such a capture it plays
 * again too.
 */
async function endAnimations(page: Page) {
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      const end = animation.effect?.getComputedTiming().endTime;
      if (typeof end === "number" && Number.isFinite(end)) animation.finish();
    }
  });
}
