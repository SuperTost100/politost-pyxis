/** A token count for reading: grouped in full, or short ("12K") for a figure that sits beside other controls. */
export function formatTokens(count: number, locale: string, short = false): string {
  return new Intl.NumberFormat(
    locale,
    short ? { notation: "compact", maximumFractionDigits: 1 } : {},
  ).format(count);
}

/** The share of input tokens the prompt cache served, as a whole percent. Null when nothing came from the cache. */
export function cacheShare(usage: { inputTokens: number; cacheReadTokens: number }): number | null {
  if (usage.cacheReadTokens <= 0 || usage.inputTokens <= 0) return null;
  return Math.round((Math.min(usage.cacheReadTokens, usage.inputTokens) / usage.inputTokens) * 100);
}
