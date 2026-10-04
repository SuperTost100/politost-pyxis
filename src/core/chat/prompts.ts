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

export function chatSystemPrompt(
  id: ChatTemplateId,
  contentLanguage: string,
): string {
  return systemPrompt(id, { contentLanguage });
}

/** Stored with each assistant message: the template ID and its own version. */
export const chatProvenance = promptProvenance;
