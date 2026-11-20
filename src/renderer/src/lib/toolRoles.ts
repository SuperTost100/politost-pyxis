import { taskTier } from "../../../shared/effort";

export type Role = "fast" | "mid" | "strong";
export const roles: readonly Role[] = ["fast", "mid", "strong"];
export type RoleModels = Record<Role, string | null>;

/** The tasks the explanatory line under the list names, by role. The test keeps it equal to `resources/model-tiers.json`. */
export const sentenceTasks: Record<Role, readonly string[]> = {
  fast: ["chat", "cards", "map"],
  mid: ["lesson", "grading"],
  strong: ["plan"],
};

/**
 * A model's name inside its own tool's row. "Claude Haiku 5.5" reads "Haiku 5.5" under Claude, which the row already
 * names. The other makers' names carry the model's family ("GPT-6 Luna", "Gemini 4 Argon") and stay, except that the tool
 * spells some GPT names with a hyphen before the model's own name ("GPT-6-Luna", "GPT-6.1-Sol") and others with a
 * space ("GPT-6.1 Terra"), so all of them are spelled with the space.
 */
export function roleModelName(name: string): string {
  return name.replace(/^Claude (?=\S)/, "").replace(/^(GPT-\d+(?:\.\d+)*)-(?=[A-Za-z])/, "$1 ");
}

/** The three roles of a tool with the model each one runs, in the order of the row. A role with no model is left out. */
export function roleItems(models: RoleModels, nameOf: (id: string) => string): Array<{ role: Role; model: string }> {
  return roles.flatMap((role) => (models[role] ? [{ role, model: roleModelName(nameOf(models[role]!)) }] : []));
}

/** The tasks that run in another role on this tool than the sentence under the list says, with the role they run in. */
export function roleExceptions(tasks: Record<string, Role>): Array<{ feature: string; role: Role }> {
  return Object.entries(tasks)
    .filter(([feature, role]) => role !== taskTier(feature))
    .map(([feature, role]) => ({ feature, role }));
}

/** The roles a model fills on its tool, in the order of the row; a model that fills all three says none. */
export function rolesOfModel(models: RoleModels, id: string): Role[] {
  const filled = roles.filter((role) => models[role] === id);
  return filled.length === roles.length ? [] : filled;
}
