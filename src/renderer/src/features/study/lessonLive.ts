/**
 * Whether the lesson page shows the streamed text rather than the saved lesson. Citation labels and passage ids must
 * come from the same source as the text, or a [Pn] chip reads the wrong passage (or none).
 */
export function showsLiveText(input: {
  writing: boolean;
  live: string;
  saved: string | undefined;
  cancelled: boolean;
}): boolean {
  if (input.writing) return input.live !== "";
  return input.saved === undefined && input.cancelled;
}

/**
 * The figures the lesson page shows, from the same source as its text: the ones told while the lesson is written when the
 * streamed text shows, the saved lesson's when that shows. Merged, a figure of the new text that failed (told as empty)
 * would take the picture the saved version of that block had.
 */
export function shownFigures(input: {
  fromLive: boolean;
  live: Record<string, string>;
  saved: Record<string, string> | undefined;
}): Record<string, string> {
  return input.fromLive ? input.live : (input.saved ?? {});
}
