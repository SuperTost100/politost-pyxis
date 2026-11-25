import { stripCheckFences } from "../../../../shared/math-check";
import { parseMathText } from "../../components/math/mathString";
import {
  mapFigureBlocks,
  stripPassageRefsOutsideCode,
} from "../../../../shared/smart-text";
import { stripToolBlocks } from "../../../../shared/tool-blocks";
import { CHAT_BLOCK_TEXT, chatBlocksAsText } from "../../../../shared/chat-blocks";

/**
 * A reply as a person reads it: no check blocks, no tool blocks, no [P3] passage markers, a figure's caption instead
 * of its code, a chart as its table and a practice question with its options and, from `picks`, the student's answer.
 * Copy and the screen-reader announcement use it.
 */
export function replyPlainText(body: string, language = "it", picks: Record<string, number> = {}): string {
  const lang = language.startsWith("en") ? "en" : "it";
  const text = chatBlocksAsText(
    mapFigureBlocks(stripToolBlocks(body), (figure) => (figure ? `*${figure.caption}*` : "")),
    CHAT_BLOCK_TEXT[lang],
    lang,
    picks,
  );
  return stripPassageRefsOutsideCode(stripCheckFences(text))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A reply's start as a card quotes it: one line of text with its block marks (headings, lists, quotes, code fences) and
 * its emphasis and links taken off. Formulas stay as `$...$`, display ones as inline ones, for the card to draw.
 */
export function answerPreview(body: string): string {
  const text = replyPlainText(body)
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "");
  return parseMathText(text)
    .map((segment) =>
      segment.kind === "math"
        ? `$${segment.latex.replace(/\s+/g, " ").trim()}$`
        : segment.text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, ""),
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
