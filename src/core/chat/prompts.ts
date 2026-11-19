import type { FigureKind } from "../../shared/figure-kinds";
import {
  systemPrompt,
  type TemplateId,
} from "../engine/prompts";
import { figureText } from "../math/figures";
import type { AnswerWay } from "./way";

/** The way of answering. Its text goes in the context block of the message, so the chat's system prompt never changes. */
export type ChatTemplateId = Extract<
  TemplateId,
  "chat.general" | "chat.socratic" | "chat.solver"
>;

/**
 * The template for a turn. A guided turn uses chat.socratic, which builds its step on the passages when there are any and
 * on the model's own knowledge when not. A solved turn uses chat.solver, with the math checks, whenever the Library was
 * searched or a file came with the question, and chat.general when nothing was (`general`).
 */
export function chatTemplateId(input: { way: AnswerWay; general?: boolean }): ChatTemplateId {
  return input.way === "guided"
    ? "chat.socratic"
    : input.general
      ? "chat.general"
      : "chat.solver";
}

/** The system prompt of a chat. It is the same for the whole chat, so a tool's session never ends because of it. */
export function chatSystemPrompt(): string {
  return systemPrompt("chat.system");
}

/**
 * What varies from turn to turn, as a block at the start of the message: the language, exam, subject, profile, whether
 * to end with follow-ups, and the way of answering with the figure kinds that can be drawn (at most two in an answer,
 * none when nothing can draw one). A session is sent the block only when it differs from the one it last received.
 */
export function contextBlock(input: {
  template: ChatTemplateId;
  language: string;
  planLine: string;
  subject: string;
  profile: string;
  followups: boolean;
  figures: readonly FigureKind[];
}): string {
  const how = figureText(systemPrompt(input.template), input.figures, 2);
  return [
    "<context>",
    `Language: ${input.language}.`,
    input.planLine,
    input.subject,
    input.profile,
    input.followups
      ? "Follow-ups: end with the <followups> block."
      : "Follow-ups: leave the <followups> block out.",
    "How to answer:",
    how,
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
