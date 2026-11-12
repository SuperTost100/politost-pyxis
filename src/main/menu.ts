import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { goPages, type MenuCommand, type MenuLanguage } from "../shared/menu";

const appName = "PoliTost Pyxis";

type Words = {
  commands: Record<MenuCommand, string>;
  file: string;
  edit: string;
  go: string;
  view: string;
  window: string;
  help: string;
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  selectAll: string;
  addToDictionary: string;
  noSuggestions: string;
  zoomIn: string;
  zoomOut: string;
  actualSize: string;
  reload: string;
  forceReload: string;
  devTools: string;
  minimize: string;
  zoom: string;
  front: string;
  close: string;
  services: string;
  hide: string;
  hideOthers: string;
  showAll: string;
  quit: string;
};

/** Menu text lives here, not in the renderer, so a renderer can only pick a language, never write a label. */
const words: Record<MenuLanguage, Words> = {
  en: {
    commands: {
      "new-exam": "New exam",
      "new-chat": "New chat",
      settings: "Settings",
      ask: "Ask",
      exams: "Exams",
      maps: "Maps",
      library: "Library",
      flashcards: "Flashcards",
      back: "Back",
      shortcuts: "Keyboard shortcuts",
      "check-updates": "Check for updates",
      "report-problem": "Report a problem",
      about: "About",
    },
    file: "File",
    edit: "Edit",
    go: "Go",
    view: "View",
    window: "Window",
    help: "Help",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    selectAll: "Select all",
    addToDictionary: "Add to dictionary",
    noSuggestions: "No suggestions",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    actualSize: "Actual size",
    reload: "Reload",
    forceReload: "Force reload",
    devTools: "Developer tools",
    minimize: "Minimize",
    zoom: "Zoom",
    front: "Bring all to front",
    close: "Close window",
    services: "Services",
    hide: "Hide",
    hideOthers: "Hide others",
    showAll: "Show all",
    quit: "Quit",
  },
  it: {
    commands: {
      "new-exam": "Nuovo esame",
      "new-chat": "Nuova chat",
      settings: "Impostazioni",
      ask: "Chiedi",
      exams: "Esami",
      maps: "Mappe",
      library: "Libreria",
      flashcards: "Flashcard",
      back: "Indietro",
      shortcuts: "Scorciatoie da tastiera",
      "check-updates": "Cerca aggiornamenti",
      "report-problem": "Segnala un problema",
      about: "Informazioni",
    },
    file: "File",
    edit: "Modifica",
    go: "Vai",
    view: "Vista",
    window: "Finestra",
    help: "Aiuto",
    undo: "Annulla",
    redo: "Ripeti",
    cut: "Taglia",
    copy: "Copia",
    paste: "Incolla",
    selectAll: "Seleziona tutto",
    addToDictionary: "Aggiungi al dizionario",
    noSuggestions: "Nessun suggerimento",
    zoomIn: "Ingrandisci",
    zoomOut: "Riduci",
    actualSize: "Dimensioni reali",
    reload: "Ricarica",
    forceReload: "Ricarica da zero",
    devTools: "Strumenti per sviluppatori",
    minimize: "Riduci a icona",
    zoom: "Zoom",
    front: "Porta tutto in primo piano",
    close: "Chiudi finestra",
    services: "Servizi",
    hide: "Nascondi",
    hideOthers: "Nascondi altre",
    showAll: "Mostra tutto",
    quit: "Esci",
  },
};

export type MenuOptions = {
  platform: NodeJS.Platform;
  language: MenuLanguage;
  /** Packaged builds leave out reload and developer tools. */
  packaged: boolean;
  send: (command: MenuCommand) => void;
};

/**
 * The application menu. macOS gets the app menu with Settings and About in it, and a Window menu. Windows and Linux
 * keep Settings in File and About in Help, and their window hides the bar until Alt is pressed. Every item that runs a
 * command has the command as its id, so a test can find it. The renderer decides whether a command may run now.
 */
export function buildMenuTemplate(
  options: MenuOptions,
): MenuItemConstructorOptions[] {
  const { platform, language, packaged, send } = options;
  const mac = platform === "darwin";
  const w = words[language];
  const command = (
    name: MenuCommand,
    accelerator?: string,
    label: string = w.commands[name],
  ): MenuItemConstructorOptions => ({
    id: name,
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => send(name),
  });
  const settings = command(
    "settings",
    "CmdOrCtrl+,",
    mac ? `${w.commands.settings}…` : w.commands.settings,
  );
  const about = command(
    "about",
    undefined,
    mac ? `${w.commands.about} ${appName}` : w.commands.about,
  );

  const appMenu: MenuItemConstructorOptions[] = mac
    ? [
        {
          label: appName,
          submenu: [
            about,
            { type: "separator" },
            settings,
            { type: "separator" },
            { role: "services", label: w.services },
            { type: "separator" },
            { role: "hide", label: `${w.hide} ${appName}` },
            { role: "hideOthers", label: w.hideOthers },
            { role: "unhide", label: w.showAll },
            { type: "separator" },
            { role: "quit", label: `${w.quit} ${appName}` },
          ],
        },
      ]
    : [];

  const file: MenuItemConstructorOptions = {
    label: w.file,
    submenu: [
      command("new-exam", "CmdOrCtrl+N"),
      command("new-chat", "CmdOrCtrl+Shift+N"),
      { type: "separator" },
      ...(mac
        ? [{ role: "close" as const, label: w.close }]
        : [
            settings,
            { type: "separator" as const },
            { role: "quit" as const, label: w.quit },
          ]),
    ],
  };

  const edit: MenuItemConstructorOptions = {
    label: w.edit,
    submenu: [
      { role: "undo", label: w.undo },
      { role: "redo", label: w.redo },
      { type: "separator" },
      { role: "cut", label: w.cut },
      { role: "copy", label: w.copy },
      { role: "paste", label: w.paste },
      { role: "selectAll", label: w.selectAll },
    ],
  };

  const go: MenuItemConstructorOptions = {
    label: w.go,
    submenu: [
      ...goPages.map((page) => command(page.command, page.accelerator)),
      { type: "separator" },
      command("back", mac ? "Cmd+[" : "Alt+Left"),
    ],
  };

  const view: MenuItemConstructorOptions = {
    label: w.view,
    submenu: [
      { role: "zoomIn", label: w.zoomIn },
      { role: "zoomOut", label: w.zoomOut },
      { role: "resetZoom", label: w.actualSize },
      ...(packaged
        ? []
        : [
            { type: "separator" as const },
            { role: "reload" as const, label: w.reload },
            { role: "forceReload" as const, label: w.forceReload },
            { role: "toggleDevTools" as const, label: w.devTools },
          ]),
    ],
  };

  const windowMenu: MenuItemConstructorOptions[] = mac
    ? [
        {
          label: w.window,
          role: "window",
          submenu: [
            { role: "minimize", label: w.minimize },
            { role: "zoom", label: w.zoom },
            { type: "separator" },
            { role: "front", label: w.front },
          ],
        },
      ]
    : [];

  const help: MenuItemConstructorOptions = {
    label: w.help,
    ...(mac ? { role: "help" as const } : {}),
    submenu: [
      command("shortcuts", "CmdOrCtrl+/"),
      { type: "separator" },
      command("check-updates"),
      command("report-problem"),
      ...(mac ? [] : [{ type: "separator" as const }, about]),
    ],
  };

  return [...appMenu, file, edit, go, view, ...windowMenu, help];
}

/** Where a context menu opens when the window names a place: two finite coordinates inside a window, rounded; else null. */
export function contextMenuAnchor(raw: unknown): { x: number; y: number } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { x, y } = raw as Record<string, unknown>;
  const inside = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 20_000;
  return inside(x) && inside(y) ? { x: Math.round(x), y: Math.round(y) } : null;
}

/**
 * The items of a context menu the window asked for, or null when the request is not one: at most 20 items, each a
 * separator (null) or an id and a label of plain text.
 */
export function contextMenuItems(raw: unknown): Array<{ id: string; label: string; enabled?: boolean } | null> | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) return null;
  const items: Array<{ id: string; label: string; enabled?: boolean } | null> = [];
  for (const item of raw) {
    if (item === null) {
      items.push(null);
      continue;
    }
    if (typeof item !== "object") return null;
    const { id, label, enabled } = item as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0 || id.length > 64) return null;
    if (typeof label !== "string" || label.length === 0 || label.length > 120) return null;
    if (enabled !== undefined && typeof enabled !== "boolean") return null;
    items.push(enabled === undefined ? { id, label } : { id, label, enabled });
  }
  return items;
}

/** What the text menu reads of a window's `context-menu` event. */
export type TextMenuParams = Pick<
  ContextMenuParams,
  "isEditable" | "selectionText" | "misspelledWord" | "dictionarySuggestions" | "formControlType" | "editFlags"
>;

/** What the text menu's spelling items do: `replace` swaps the misspelled word in the field, `learn` adds it to the dictionary. */
export type TextMenuActions = { replace: (word: string) => void; learn: (word: string) => void };

/** The most suggestions the menu lists above its edit items. */
const MAX_SUGGESTIONS = 5;
const TEXT_FIELDS: ReadonlySet<string> = new Set([
  "input-text",
  "input-search",
  "input-email",
  "input-url",
  "input-telephone",
  "input-number",
  "text-area",
]);

/**
 * The menu a right-click opens on text, in the interface language. Electron gives a page no menu of its own, so the
 * window builds this one from its `context-menu` event, which the window's own menus (covers, rows, tiles) never
 * cause: they prevent the page's `contextmenu`, and Chromium then sends nothing. The items are roles, which act on the
 * focused field, except the spelling ones, which `actions` runs. Returns null when there is nothing to offer:
 *
 * - a field the student can write in: the misspelled word's suggestions and "Aggiungi al dizionario" first, then Annulla,
 *   Ripeti, Taglia, Copia, Incolla and Seleziona tutto, each on only when it applies; a password field has no Taglia or Copia;
 * - a field that is read-only: Copia and Seleziona tutto;
 * - selected text elsewhere on the page: Copia.
 */
export function textMenuTemplate(
  params: TextMenuParams,
  language: MenuLanguage,
  actions: TextMenuActions,
): MenuItemConstructorOptions[] | null {
  const w = words[language];
  const flags = params.editFlags;
  const password = params.formControlType === "input-password";
  const copy: MenuItemConstructorOptions = { role: "copy", label: w.copy, enabled: flags.canCopy && !password };
  const selectAll: MenuItemConstructorOptions = { role: "selectAll", label: w.selectAll, enabled: flags.canSelectAll };
  if (!params.isEditable) {
    if (TEXT_FIELDS.has(params.formControlType)) return [copy, selectAll];
    return params.selectionText.trim() ? [copy] : null;
  }
  const spelling: MenuItemConstructorOptions[] = params.misspelledWord
    ? [
        ...(params.dictionarySuggestions.length
          ? params.dictionarySuggestions
              .slice(0, MAX_SUGGESTIONS)
              .map((word): MenuItemConstructorOptions => ({ label: word, click: () => actions.replace(word) }))
          : [{ label: w.noSuggestions, enabled: false }]),
        { type: "separator" },
        { label: w.addToDictionary, click: () => actions.learn(params.misspelledWord) },
        { type: "separator" },
      ]
    : [];
  return [
    ...spelling,
    { role: "undo", label: w.undo, enabled: flags.canUndo },
    { role: "redo", label: w.redo, enabled: flags.canRedo },
    { type: "separator" },
    ...(password ? [] : [{ role: "cut" as const, label: w.cut, enabled: flags.canCut }, copy]),
    { role: "paste", label: w.paste, enabled: flags.canPaste },
    { type: "separator" },
    selectAll,
  ];
}
