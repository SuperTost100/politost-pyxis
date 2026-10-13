import { stripCheckFences } from "../../../../shared/math-check";
import { stripPassageRefs } from "../../../../shared/smart-text";

/** A reply as a person reads it: no check blocks and no [P3] passage markers. Copy and the screen-reader announcement use it. */
export function replyPlainText(body: string): string {
  return stripPassageRefs(stripCheckFences(body))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
