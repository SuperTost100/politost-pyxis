import { stripCheckFences } from "../../../../shared/math-check";
import {
  mapFigureBlocks,
  stripPassageRefsOutsideCode,
} from "../../../../shared/smart-text";

/**
 * A reply as a person reads it: no check blocks, no [P3] passage markers, and a figure's caption instead of its code.
 * Copy and the screen-reader announcement use it.
 */
export function replyPlainText(body: string): string {
  const text = mapFigureBlocks(body, (figure) =>
    figure ? `*${figure.caption}*` : "",
  );
  return stripPassageRefsOutsideCode(stripCheckFences(text))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
