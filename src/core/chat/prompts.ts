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

/** ASK-03: with the switch off, the follow-up instruction is left out of the template. */
export function chatSystemPrompt(
  id: ChatTemplateId,
  contentLanguage: string,
  followups = true,
): string {
  const text = systemPrompt(id, { contentLanguage });
  if (followups) return text;
  return text
    .split("\n")
    .filter((line) => !line.includes("<followups>"))
    .join("\n");
}

/** Stored with each assistant message: the template ID and its own version. */
export const chatProvenance = promptProvenance;
