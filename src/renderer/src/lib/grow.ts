/**
 * The dialog grows out of `from` (a button) and shrinks back into it: it moves and scales from the button's centre,
 * 320 ms in and 220 ms out. With reduced motion, or with no button on screen, it only fades.
 */
export function grow(
  node: HTMLElement,
  from: HTMLElement | null,
  way: "in" | "out",
  done?: () => void,
) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const start = from?.getBoundingClientRect();
  const end = node.getBoundingClientRect();
  let frames: Keyframe[];
  if (reduced || !start || !start.width || !end.width)
    frames = [{ opacity: 0 }, { opacity: 1 }];
  else {
    const dx = start.left + start.width / 2 - (end.left + end.width / 2);
    const dy = start.top + start.height / 2 - (end.top + end.height / 2);
    const scale = Math.max(start.width / end.width, 0.2);
    frames = [
      { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
      { opacity: 1, transform: "none" },
    ];
  }
  if (way === "out") frames.reverse();
  const animation = node.animate(frames, {
    duration: reduced ? 120 : way === "in" ? 320 : 220,
    easing: "cubic-bezier(0.23, 1, 0.32, 1)",
  });
  if (done) animation.onfinish = done;
}
