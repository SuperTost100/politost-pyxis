import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Waits until no finite animation or transition is running, so a click can't land on a dialog or menu that is still
 * zooming in, and axe doesn't measure the contrast of a colour halfway through a fade. On a slow runner such a click is
 * lost. A student can't click that fast, so this is a test-only wait. Spinners loop forever and are not waited for.
 * `within` limits the wait to one element and what it contains.
 *
 * Ant Design's motion first marks an entering dialog with classes such as `ant-zoom-appear-prepare`, which hold it at
 * opacity 0 for a frame before its CSS animation starts. In that frame no animation is running yet, so the wait also
 * holds while a shown element carries one of those pre-animation classes (`ant-…-appear`, `-enter` or `-leave`, then
 * `-prepare` or `-start`). Once the animation runs, the count above covers it.
 */
/**
 * Waits until `element` is at rest: the same box and window size for ten animation frames in a row, with no `scroll` or
 * `resize` event among them. A spec calls it before it opens a menu right after its own scroll or resize.
 *
 * The page shows a resize or a scroll in its layout at once, but fires the `resize` or `scroll` event at its next frame,
 * and a busy Mac runner draws that frame late. A menu opened in between hears the test's own event after it opened:
 * a right-click menu closes on any resize, and a menu closes on a scroll that moved its item. A student cannot resize or
 * scroll and open a menu inside one frame, so this is a test-only wait for what the test itself set in motion. It also
 * waits for a box that the app is still placing, such as a submenu moved into the window a frame after it opens.
 *
 * The page can replace the element while this waits (a streamed reply by its saved one, a panel's text by the text of
 * its next opening). An element that has left the page keeps a still, empty box, so the wait then starts again on the
 * element the locator finds now.
 */
export async function atRest(element: Locator) {
  while (!(await stillThereAtRest(element)));
}

/** One wait of `atRest`: true when the element found at the start was still in the page when it came to rest. */
function stillThereAtRest(element: Locator) {
  return element.evaluate(
    (node) =>
      new Promise<boolean>((resolve) => {
        const place = () => {
          const box = node.getBoundingClientRect();
          return [box.left, box.top, box.width, box.height, innerWidth, innerHeight].join(" ");
        };
        let last = place();
        let quiet = 0;
        const restart = () => {
          quiet = 0;
        };
        addEventListener("resize", restart);
        addEventListener("scroll", restart, true);
        const frame = () => {
          const now = place();
          quiet = now === last ? quiet + 1 : 0;
          last = now;
          if (quiet < 10) return void requestAnimationFrame(frame);
          removeEventListener("resize", restart);
          removeEventListener("scroll", restart, true);
          resolve(node.isConnected);
        };
        requestAnimationFrame(frame);
      }),
  );
}

export async function animationsSettled(page: Page, within?: Locator) {
  // Runs in the page: the finite animations still running under `root` (the whole document without one), plus the
  // elements that still carry an Ant Design motion class.
  const busy = (root: Element | undefined) => {
    const animations = root ? root.getAnimations({ subtree: true }) : document.getAnimations();
    const running = animations.filter(
      (animation) => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity,
    ).length;
    const motion = /(^|\s)ant-[\w-]+-(appear|enter|leave)-(prepare|start)(?=\s|$)/;
    const elements = root ? [root, ...root.querySelectorAll("[class]")] : [...document.querySelectorAll("[class]")];
    // A closed drawer or popover can stay in the DOM, hidden, with its leave class; only a shown element can be mid-fade.
    const shown = (element: Element) =>
      element instanceof HTMLElement && element.checkVisibility({ checkVisibilityCSS: true });
    return (
      running + elements.filter((element) => motion.test(element.getAttribute("class") ?? "") && shown(element)).length
    );
  };
  await expect.poll(() => (within ? within.evaluate(busy) : page.evaluate(busy, undefined))).toBe(0);
}
