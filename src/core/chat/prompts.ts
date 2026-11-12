import {
  systemPrompt,
  type TemplateId,
} from "../engine/prompts";
import type { AnswerWay } from "./way";

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

/**
 * ASK-03: with the switch off, the follow-up instruction is left out of the template. The figure instruction is left
 * out when there is no sandbox to draw figures in.
 */
export function chatSystemPrompt(
  id: ChatTemplateId,
  contentLanguage: string,
  followups = true,
  figures = false,
): string {
  return systemPrompt(id, { contentLanguage })
    .split("\n")
    .filter(
      (line) =>
        (followups || !line.includes("<followups>")) &&
        (figures || !line.includes("pyxis-figure")),
    )
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
