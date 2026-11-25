import { taskTier } from "../../../shared/effort";

export type Role = "fast" | "mid" | "strong";
export const roles: readonly Role[] = ["fast", "mid", "strong"];
export type RoleModels = Record<Role, string | null>;

/** The tasks the explanatory line under the list names, in the order it says them. */
export const sentenceTasks: readonly string[] = ["chat", "cards", "map", "lesson", "grading", "plan", "solve"];

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

export type RoleSummary = {
  /** The tasks every connected tool runs in the same role, by that role, in the sentence's order. */
  agreed: Record<Role, string[]>;
  /** The tasks the tools do not agree on, each with the tools that run it in each role, fast to strong. */
  split: Array<{ task: string; roles: Array<{ role: Role; tools: string[] }> }>;
};

/**
 * What the line under the list of tools says about the roles, from the roles the connected tools really give each task
 * (`engines.roles`), so the line is true of every tool shown: a task the tools agree on goes under its role, and one
 * they do not (the chat runs on the balanced model of Claude and ChatGPT and the fast one of Gemini) is said apart with
 * the tools of each role, the role most tools use first. A tool with no data for a task, and no tool at all, follow `resources/model-tiers.json`.
 */
export function roleSummary(tools: ReadonlyArray<{ name: string; tasks: Partial<Record<string, Role>> }>): RoleSummary {
  const agreed: Record<Role, string[]> = { fast: [], mid: [], strong: [] };
  const split: RoleSummary["split"] = [];
  for (const task of sentenceTasks) {
    const given = tools.map((tool) => ({ name: tool.name, role: tool.tasks[task] ?? taskTier(task) }));
    const kinds = roles.filter((role) => given.some((item) => item.role === role));
    if (kinds.length <= 1) agreed[kinds[0] ?? taskTier(task)].push(task);
    else
      split.push({
        task,
        // The role most tools run it in comes first; equal groups keep the order fast, balanced, strong.
        roles: kinds
          .map((role) => ({ role, tools: given.filter((item) => item.role === role).map((item) => item.name) }))
          .sort((a, b) => b.tools.length - a.tools.length),
      });
  }
  return { agreed, split };
}

/** The roles a model fills on its tool, in the order of the row; a model that fills all three says none. */
export function rolesOfModel(models: RoleModels, id: string): Role[] {
  const filled = roles.filter((role) => models[role] === id);
  return filled.length === roles.length ? [] : filled;
}
