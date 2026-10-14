/**
 * Multiple-choice order. A model writes options in the order it likes (often with the right one in the same few
 * places), so every closed question the app keeps is rearranged once and its correct index follows the move.
 */

/** A small deterministic generator (mulberry32) seeded from text, so the same text always gives the same stream. */
export function seededRandom(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Shuffled<T> = {
  options: T[];
  /** Where the right option sits now. */
  correct: number;
  /** For each shown position, the position the option had before: `options[i]` was `original[order[i]]`. */
  order: number[];
};

/** Fisher-Yates over the positions. `random` returns a number in [0, 1). */
export function shuffleChoices<T>(
  options: readonly T[],
  correct: number,
  random: () => number,
): Shuffled<T> {
  const order = options.map((_, index) => index);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return {
    options: order.map((from) => options[from]!),
    correct: order.indexOf(correct),
    order,
  };
}
