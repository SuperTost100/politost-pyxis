import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Waits until no finite animation or transition is running, so a click can't land on a dialog or menu that is still
 * zooming in, and axe doesn't measure the contrast of a colour halfway through a fade. On a slow runner such a click is
 * lost. A student can't click that fast, so this is a test-only wait. Spinners loop forever and are not waited for.
 * `within` limits the wait to one element and what it contains.
 *
 * Ant Design's motion first marks an entering dialog with classes such as `ant-zoom-appear-prepare`, which hold it at
 * opacity 0 for a frame before its CSS animation starts. In that frame no animation is running yet, so the wait also
 * holds while any element still carries an `ant-…-appear`, `-enter` or `-leave` class.
 */
export async function animationsSettled(page: Page, within?: Locator) {
  // Runs in the page: the finite animations still running under `root` (the whole document without one), plus the
  // elements that still carry an Ant Design motion class.
  const busy = (root: Element | undefined) => {
    const animations = root ? root.getAnimations({ subtree: true }) : document.getAnimations();
    const running = animations.filter(
      (animation) => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity,
    ).length;
    const motion = /(^|\s)ant-[\w-]+-(appear|enter|leave)(-[\w-]+)?(?=\s|$)/;
    const elements = root ? [root, ...root.querySelectorAll("[class]")] : [...document.querySelectorAll("[class]")];
    return running + elements.filter((element) => motion.test(element.getAttribute("class") ?? "")).length;
  };
  await expect.poll(() => (within ? within.evaluate(busy) : page.evaluate(busy, undefined))).toBe(0);
}
