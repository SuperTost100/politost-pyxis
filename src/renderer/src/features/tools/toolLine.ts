import type { BackTarget } from "../../app/back-slot";

/**
 * The line under a tool's title: the chat it was opened from. A new chat has no title yet, and a tool opened from
 * nowhere leads to Chiedi, so both leave the line out rather than repeat the back control's name.
 */
export function toolLine(back: BackTarget | null): string | undefined {
  return back && /^\/ask\/[^/?#]+/.test(back.to) ? back.name : undefined;
}
