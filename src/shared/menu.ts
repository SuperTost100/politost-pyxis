export type MenuLanguage = "it" | "en";

const sections = [
  { command: "ask", path: "/ask" },
  { command: "exams", path: "/exams" },
  { command: "maps", path: "/maps" },
  { command: "flashcards", path: "/flashcards" },
  { command: "library", path: "/exams/library" },
] as const;

/**
 * The app's sections in the sidebar's order, which the Go menu, the number keys (Ctrl or Command and 1, 2…), the
 * sidebar's key hints and Help > Keyboard shortcuts all follow: a section's key is its place here. A new page is one
 * entry here, a label in both languages in `src/main/menu.ts` (the build fails without it), its row in the sidebar and
 * the shortcuts dialog and, if it has a page, a route in the renderer.
 */
export const goPages = sections.map((page, index) => ({
  ...page,
  /** The number of its place, as Electron writes an accelerator. */
  accelerator: `CmdOrCtrl+${index + 1}`,
}));

/** Menu commands that open a fixed page. */
export const pageCommands = {
  "new-exam": "/plans/new",
  "new-chat": "/ask",
  settings: "/settings",
  // The version and licences, inside Informazioni.
  about: "/settings/version",
  "check-updates": "/settings/updates",
} as const;

export type GoCommand = (typeof sections)[number]["command"];
export type MenuCommand =
  | GoCommand
  | keyof typeof pageCommands
  | "back"
  | "shortcuts"
  | "report-problem";

const commands: ReadonlySet<string> = new Set<MenuCommand>([
  ...goPages.map((page) => page.command),
  ...(Object.keys(pageCommands) as Array<keyof typeof pageCommands>),
  "back",
  "shortcuts",
  "report-problem",
]);

/** Main sends a command and the preload checks it, so nothing outside this list reaches the renderer's router. */
export function isMenuCommand(value: unknown): value is MenuCommand {
  return typeof value === "string" && commands.has(value);
}

export function isMenuLanguage(value: unknown): value is MenuLanguage {
  return value === "it" || value === "en";
}

/** Where Help > Report a problem leads. It goes through the same `openExternal` as every other link. */
export const reportProblemUrl =
  "https://github.com/SuperTost100/politost-pyxis/issues/new";
