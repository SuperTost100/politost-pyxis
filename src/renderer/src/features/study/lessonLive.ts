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
