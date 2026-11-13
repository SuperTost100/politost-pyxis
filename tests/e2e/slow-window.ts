import type { Page } from "@playwright/test";

/**
 * Makes the window draw about `fps` frames a second, the way a busy hosted runner's hidden window does: every
 * animation frame is followed by a stretch in which the page's main thread is busy, so the next frame comes late and
 * clicks, timers and replies from the app wait for it as well. A student on a slow computer sees the same. The slowdown
 * stays until the page reloads.
 *
 * `Emulation.setCPUThrottlingRate` slows the scripts down but still draws as often as the screen asks, so a test that
 * counts frames needs this instead.
 */
export async function drawSlowly(page: Page, fps: number) {
  await page.evaluate(
    (interval) => {
      const frame = () => {
        const until = performance.now() + interval;
        while (performance.now() < until) {
          // Busy on purpose.
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },
    1000 / fps - 10,
  );
}
