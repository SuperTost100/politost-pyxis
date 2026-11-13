/** How long covers take to shrink away, and the shelf to close up after (docs/design-system/motion.md). */
const SHRINK_MS = 220;
const CLOSE_MS = 200;
const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Two frames: React has committed the new list and the browser has laid it out. */
const laidOut = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/**
 * Removes files from the Library's shelves the way the design system removes an item: the covers of `leaving` shrink in
 * place, `update` then takes them out of the list, and the covers that stay slide into the gap. The shelves own their
 * covers, so this works on what they draw (`[data-source-id]` under `.px-shelves`) and needs nothing from them. Under
 * reduced motion, or with no shelves on screen, it runs `update` alone. A failed `update` puts the covers back.
 */
export async function closeUpShelves(leaving: readonly string[], update: () => Promise<void>): Promise<void> {
  const root = document.querySelector<HTMLElement>(".px-shelves");
  if (!root || reducedMotion()) return update();
  const covers = () => [...root.querySelectorAll<HTMLElement>("[data-source-id]")];
  const going = new Set(leaving);
  const shrinking = covers()
    .filter((cover) => going.has(cover.dataset.sourceId ?? "") && cover.getClientRects().length > 0)
    .map((cover) =>
      cover.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.85)" }], {
        duration: SHRINK_MS,
        easing: EASE_IN_OUT,
        fill: "forwards",
      }),
    );
  await Promise.all(shrinking.map((animation) => animation.finished.catch(() => undefined)));
  const before = new Map(
    covers()
      .filter((cover) => !going.has(cover.dataset.sourceId ?? ""))
      .map((cover) => [cover.dataset.sourceId!, cover.getBoundingClientRect()]),
  );
  try {
    await update();
  } catch (err) {
    for (const animation of shrinking) animation.cancel();
    throw err;
  }
  await laidOut();
  for (const cover of covers()) {
    const was = before.get(cover.dataset.sourceId ?? "");
    if (!was) continue;
    const now = cover.getBoundingClientRect();
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    cover.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
      duration: CLOSE_MS,
      easing: EASE_IN_OUT,
    });
  }
}
