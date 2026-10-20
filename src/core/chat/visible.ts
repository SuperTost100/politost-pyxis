import { stripCheckFences } from "../../shared/math-check";
import { stripPassageRefsOutsideCode } from "../../shared/smart-text";
import { splitChecks } from "./checks";
import { splitFollowups } from "./turn";
import { figureCaptions } from "../math/figures";

/**
 * What a student reads in a message: an answer loses its stored `<checks>` and `<followups>` envelope, its check
 * fences and its [P3] passage markers, and a figure becomes its caption. Search and export both work from this text.
 */
export function visibleText(role: string, body: string): string {
  if (role !== "assistant") return body.trim();
  return stripPassageRefsOutsideCode(
    figureCaptions(stripCheckFences(splitFollowups(splitChecks(body).body).body)),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
