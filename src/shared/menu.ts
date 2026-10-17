export type MenuLanguage = "it" | "en";

/**
 * Pages with a number key in the Go menu, in menu order: the three header sections first, then the Exams tabs. A new page is one entry here, a label in both languages in
 * `src/main/menu.ts` (the build fails without it) and, if it has a page, a route in the renderer.
 */
export const goPages = [
  { command: "ask", accelerator: "CmdOrCtrl+1", path: "/ask" },
  { command: "exams", accelerator: "CmdOrCtrl+2", path: "/exams" },
  { command: "maps", accelerator: "CmdOrCtrl+3", path: "/maps" },
  { command: "library", accelerator: "CmdOrCtrl+4", path: "/exams/library" },
  { command: "flashcards", accelerator: "CmdOrCtrl+5", path: "/exams/cards" },
] as const;

/** Menu commands that open a fixed page. */
export const pageCommands = {
  "new-exam": "/plans/new",
  "new-chat": "/ask",
  settings: "/settings",
  about: "/settings/about",
  "check-updates": "/settings/updates",
} as const;

export type GoCommand = (typeof goPages)[number]["command"];
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
