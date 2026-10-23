import {
  systemPrompt,
  type TemplateId,
} from "../engine/prompts";

export type ChatTemplateId = Extract<
  TemplateId,
  "chat.general" | "chat.socratic" | "chat.solver"
>;

/**
 * Socratic mode wins over "answer from general knowledge": chat.socratic already builds its question on the
 * model's own knowledge when no passage is attached, so a student who chose to be questioned still is.
 */
export function chatTemplateId(input: {
  allowGeneral?: boolean;
  mode?: string;
}): ChatTemplateId {
  return input.mode === "socratic"
    ? "chat.socratic"
    : input.allowGeneral
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
