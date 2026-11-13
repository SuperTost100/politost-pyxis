/**
 * The AI tools by the names a student knows (docs/design-system/copy.md): the account they have, not the program Pyxis
 * runs. Product names, so the same in every language. Provider ids, settings keys and stored values stay as they are.
 */
export const TOOL_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "ChatGPT",
  agent: "Cursor",
  antigravity: "Gemini",
};

/**
 * The program each tool runs, for the one place that has to say which program to install or sign in to (a row in
 * Settings), written once as a detail under the tool's name and nowhere else.
 */
export const TOOL_PROGRAMS: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  agent: "Cursor Agent",
  antigravity: "Antigravity",
};

/**
 * A tool's name as stored before it was renamed, such as "Claude Code (Claude Haiku 5)" in an old job's fallback, as it
 * reads now ("Claude (Claude Haiku 5)"). Any other text stays as it is.
 */
export function currentToolLabel(label: string): string {
  for (const [id, program] of Object.entries(TOOL_PROGRAMS))
    if (label === program || label.startsWith(`${program} (`)) return TOOL_NAMES[id]! + label.slice(program.length);
  return label;
}
