import type { MenuItemConstructorOptions } from "electron";
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
