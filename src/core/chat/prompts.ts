import {
  promptProvenance,
  systemPrompt,
  type TemplateId,
} from "../engine/prompts";

export type ChatTemplateId = Extract<
  TemplateId,
  "chat.general" | "chat.socratic" | "chat.solver"
>;

export function chatTemplateId(input: {
  allowGeneral?: boolean;
  mode?: string;
}): ChatTemplateId {
  return input.allowGeneral
    ? "chat.general"
    : input.mode === "socratic"
      ? "chat.socratic"
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

/** Stored with each assistant message: the template ID and its own version. */
export const chatProvenance = promptProvenance;
