import { expect, type Page } from "@playwright/test";

/**
 * Waits until no finite animation or transition is running, so a click can't land on a dialog or menu that is still
 * zooming in, and axe doesn't measure the contrast of a colour halfway through a fade. On a slow runner such a click is
 * lost. A student can't click that fast, so this is a test-only wait.
 */
export async function animationsSettled(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState === "running" &&
                animation.effect?.getTiming().iterations !== Infinity,
            ).length,
      ),
    )
    .toBe(0);
}
