import { figureKinds, type FigureKind } from "../../shared/figure-kinds";
import {
  systemPrompt,
  type TemplateId,
} from "../engine/prompts";
import { figureText } from "../math/figures";

/** The chat's template. It is the one system prompt of every chat turn, and it is the same for the whole chat. */
export const CHAT_TEMPLATE = "chat.tutor" satisfies TemplateId;

/**
 * The system prompt of a chat, with the instruction for every figure kind (at most two in an answer). The context block
 * of each message lists the kinds that can be drawn, so the system prompt never changes with the drawing pack.
 */
export function chatSystemPrompt(): string {
  return figureText(systemPrompt(CHAT_TEMPLATE), figureKinds, 2);
}

/**
 * What varies from turn to turn, as a block at the start of the message: the language, exam, subject, profile, whether to
 * end with follow-ups and which figure kinds can be drawn. A session is sent the block only when it differs from the one
 * it last received.
 */
export function contextBlock(input: {
  language: string;
  planLine: string;
  subject: string;
  profile: string;
  followups: boolean;
  figures: readonly FigureKind[];
}): string {
  return [
    "<context>",
    `Language: ${input.language}.`,
    input.planLine,
    input.subject,
    input.profile,
    input.followups
      ? "Follow-ups: end with the <followups> block."
      : "Follow-ups: leave the <followups> block out.",
    `Figures you can draw: ${input.figures.length ? input.figures.join(", ") : "none"}.`,
    "</context>",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Material the tutor reads but must not obey (passages, a pinned context, an attached file) sits between tags. A tag
 * of the same name inside the text is written as `&lt;`, so the text cannot close the block early.
 */
export function dataBlock(tag: string, body: string): string {
  const safe = body.replace(new RegExp(`<(/?${tag})`, "gi"), "&lt;$1");
  return `<${tag}>\n${safe}\n</${tag}>`;
}
