import { stripCheckFences } from "../../shared/math-check";
import { stripPassageRefsOutsideCode } from "../../shared/smart-text";
import { splitChecks } from "./checks";
import { splitFollowups } from "./turn";
import { figureCaptions } from "../math/figures";
import { stripToolBlocks } from "../../shared/tool-blocks";
import { CHAT_BLOCK_TEXT, chatBlocksAsText } from "../../shared/chat-blocks";

/**
 * What a student reads in a message: an answer loses its stored `<checks>` and `<followups>` envelope, its check
 * fences, its tool blocks and its [P3] passage markers, a figure becomes its caption, a chart its table and a practice
 * question its text and options, with the student's answer from `picks` (by question id). Search and export both work
 * from this text.
 */
export function visibleText(
  role: string,
  body: string,
  language: "en" | "it" = "en",
  picks: Record<string, number> = {},
  /** Valid chart blocks stay blocks, for the printed chat, which draws them. */
  keepCharts = false,
): string {
  if (role !== "assistant") return body.trim();
  const blocks = chatBlocksAsText(
    figureCaptions(stripCheckFences(splitFollowups(splitChecks(stripToolBlocks(body)).body).body)),
    CHAT_BLOCK_TEXT[language],
    language,
    picks,
    keepCharts,
  );
  return stripPassageRefsOutsideCode(blocks)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
