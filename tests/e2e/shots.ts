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
    // A capture with animations disabled also ends the running ones, and the steps after it can rely on that, so it
    // still happens, in memory only.
    if (options.animations === "disabled") await target.screenshot(options);
    return;
  }
  const path = join(SHOTS, name);
  mkdirSync(dirname(path), { recursive: true });
  await target.screenshot({ ...options, path });
}
