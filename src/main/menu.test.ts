import type { BaseWindow, MenuItemConstructorOptions, WebFrameMain } from "electron";
import { describe, expect, it, vi } from "vitest";
import { goPages, isMenuCommand, type MenuCommand } from "../shared/menu";
import {
  buildMenuTemplate,
  contextMenuAnchor,
  contextMenuItems,
  textMenuPopupOptions,
  textMenuTemplate,
  type TextMenuParams,
} from "./menu";

type Item = MenuItemConstructorOptions;

function build(
  platform: NodeJS.Platform,
  language: "it" | "en" = "en",
  packaged = true,
  send: (command: MenuCommand) => void = () => undefined,
): Item[] {
  return buildMenuTemplate({ platform, language, packaged, send });
}

function submenu(menu: Item[], label: string): Item[] {
  const found = menu.find((item) => item.label === label);
  if (!found || !Array.isArray(found.submenu)) throw new Error(`no ${label}`);
  return found.submenu;
}

/** Every item below the top level, with its menu's name. */
function flat(menu: Item[]): Item[] {
  return menu.flatMap((item) =>
    Array.isArray(item.submenu) ? [item, ...flat(item.submenu)] : [item],
  );
}

function labels(items: Item[]): string[] {
  return items
    .filter((item) => item.type !== "separator")
    .map((item) => item.role ?? item.label ?? "");
}

describe("application menu", () => {
  it("has File, Edit, Go, View and Help on Windows and Linux, and no Window menu", () => {
    for (const platform of ["win32", "linux"] as const)
      expect(build(platform).map((item) => item.label)).toEqual([
        "File",
        "Edit",
        "Go",
        "View",
        "Help",
      ]);
  });

  it("adds the app menu and a Window menu on macOS", () => {
    const menu = build("darwin");
    expect(menu.map((item) => item.label)).toEqual([
      "PoliTost Pyxis",
      "File",
      "Edit",
      "Go",
      "View",
      "Window",
      "Help",
    ]);
    expect(menu.find((item) => item.label === "Window")?.role).toBe("window");
    expect(menu.find((item) => item.label === "Help")?.role).toBe("help");
  });

  it("puts Settings in File on Windows and Linux, and in the app menu on macOS", () => {
    for (const platform of ["win32", "linux"] as const) {
      const file = submenu(build(platform), "File");
      expect(file.find((item) => item.id === "settings")?.accelerator).toBe(
        "CmdOrCtrl+,",
      );
      expect(labels(file)).toEqual([
        "New exam",
        "New chat",
        "Settings",
        "quit",
      ]);
    }
    const menu = build("darwin");
    const app = submenu(menu, "PoliTost Pyxis");
    expect(app.find((item) => item.id === "settings")).toMatchObject({
      label: "Settings…",
      accelerator: "CmdOrCtrl+,",
    });
    expect(app.map((item) => item.role)).toEqual(
      expect.arrayContaining([
        "services",
        "hide",
        "hideOthers",
        "unhide",
        "quit",
      ]),
    );
    expect(submenu(menu, "File").some((item) => item.id === "settings")).toBe(
      false,
    );
  });

  it("gives File its two commands the documented shortcuts", () => {
    const file = submenu(build("linux"), "File");
    expect(file.find((item) => item.id === "new-exam")?.accelerator).toBe(
      "CmdOrCtrl+N",
    );
    expect(file.find((item) => item.id === "new-chat")?.accelerator).toBe(
      "CmdOrCtrl+Shift+N",
    );
  });

  it("keeps the standard edit roles so text fields work", () => {
    for (const platform of ["win32", "linux", "darwin"] as const)
      expect(
        submenu(build(platform), "Edit").flatMap((item) =>
          item.role ? [item.role] : [],
        ),
      ).toEqual(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
  });

  it("lists the Go pages with number keys, then Back with the platform's accelerator", () => {
    const go = submenu(build("linux"), "Go");
    expect(
      go
        .filter((item) => item.id !== "back" && item.type !== "separator")
        .map((item) => [item.id, item.accelerator]),
    ).toEqual(goPages.map((page) => [page.command, page.accelerator]));
    expect(go.map((item) => item.accelerator).filter(Boolean)).toEqual([
      "CmdOrCtrl+1",
      "CmdOrCtrl+2",
      "CmdOrCtrl+3",
      "CmdOrCtrl+4",
      "CmdOrCtrl+5",
      "Alt+Left",
    ]);
    expect(
      submenu(build("win32"), "Go").find((item) => item.id === "back")
        ?.accelerator,
    ).toBe("Alt+Left");
    expect(
      submenu(build("darwin"), "Go").find((item) => item.id === "back")
        ?.accelerator,
    ).toBe("Cmd+[");
  });

  it("offers zoom everywhere, and reload and developer tools only in development", () => {
    const zoom = ["zoomIn", "zoomOut", "resetZoom"];
    for (const platform of ["win32", "linux", "darwin"] as const) {
      const packaged = submenu(build(platform, "en", true), "View").map(
        (item) => item.role,
      );
      expect(packaged).toEqual(zoom);
      const dev = submenu(build(platform, "en", false), "View").flatMap(
        (item) => (item.role ? [item.role] : []),
      );
      expect(dev).toEqual([...zoom, "reload", "forceReload", "toggleDevTools"]);
    }
  });

  it("puts About in Help on Windows and Linux and in the app menu on macOS", () => {
    for (const platform of ["win32", "linux"] as const) {
      const help = submenu(build(platform), "Help");
      expect(help.map((item) => item.id).filter(Boolean)).toEqual([
        "shortcuts",
        "check-updates",
        "report-problem",
        "about",
      ]);
      expect(help.find((item) => item.id === "shortcuts")?.accelerator).toBe(
        "CmdOrCtrl+/",
      );
    }
    const mac = build("darwin");
    expect(submenu(mac, "Help").some((item) => item.id === "about")).toBe(
      false,
    );
    expect(
      submenu(mac, "PoliTost Pyxis").find((item) => item.id === "about")?.label,
    ).toBe("About PoliTost Pyxis");
  });

  it("writes every label in Italian when asked", () => {
    const menu = build("linux", "it");
    expect(menu.map((item) => item.label)).toEqual([
      "File",
      "Modifica",
      "Vai",
      "Vista",
      "Aiuto",
    ]);
    expect(labels(submenu(menu, "File"))).toEqual([
      "Nuovo esame",
      "Nuova chat",
      "Impostazioni",
      "quit",
    ]);
    expect(
      submenu(menu, "Vai").flatMap((item) => (item.label ? [item.label] : [])),
    ).toEqual(["Chiedi", "Esami", "Mappe", "Flashcard", "Libreria", "Indietro"]);
    expect(
      submenu(menu, "Aiuto").flatMap((item) =>
        item.label ? [item.label] : [],
      ),
    ).toEqual([
      "Scorciatoie da tastiera",
      "Cerca aggiornamenti",
      "Segnala un problema",
      "Informazioni",
    ]);
  });

  it("labels every item in the chosen language, roles included", () => {
    for (const language of ["en", "it"] as const)
      for (const platform of ["win32", "darwin"] as const)
        for (const item of flat(build(platform, language, false)))
          if (item.type !== "separator" && !item.submenu)
            expect(
              item.label,
              `${platform} ${language} ${item.role ?? item.id}`,
            ).toBeTruthy();
  });

  it("gives every command item an id the renderer understands, and sends it on click", () => {
    const send = vi.fn();
    const items = flat(build("linux", "en", true, send)).filter(
      (item) => item.id,
    );
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(isMenuCommand(item.id), item.id).toBe(true);
      (item.click as () => void)();
      expect(send).toHaveBeenLastCalledWith(item.id);
    }
  });

  it("uses each shortcut once per platform", () => {
    for (const platform of ["win32", "darwin"] as const) {
      const accelerators = flat(build(platform, "en", false)).flatMap((item) =>
        item.accelerator ? [String(item.accelerator)] : [],
      );
      expect(new Set(accelerators).size).toBe(accelerators.length);
    }
  });
});

describe("contextMenuAnchor", () => {
  it("keeps a place inside a window, rounded", () => {
    expect(contextMenuAnchor({ x: 12.4, y: 99.6 })).toEqual({ x: 12, y: 100 });
  });

  it("refuses anything that is not two finite coordinates", () => {
    for (const raw of [undefined, null, "10,10", { x: 1 }, { x: "1", y: 2 }, { x: NaN, y: 1 }, { x: -1, y: 4 }, { x: 1, y: 1e9 }])
      expect(contextMenuAnchor(raw)).toBeNull();
  });
});

describe("contextMenuItems", () => {
  it("keeps ids, labels, the enabled flag and separators", () => {
    expect(
      contextMenuItems([{ id: "rename", label: "Rinomina" }, null, { id: "delete", label: "Elimina", enabled: false }]),
    ).toEqual([{ id: "rename", label: "Rinomina" }, null, { id: "delete", label: "Elimina", enabled: false }]);
  });

  it("refuses anything that is not a short list of plain items", () => {
    expect(contextMenuItems("rename")).toBeNull();
    expect(contextMenuItems([])).toBeNull();
    expect(contextMenuItems(Array.from({ length: 21 }, (_, i) => ({ id: `${i}`, label: "x" })))).toBeNull();
    expect(contextMenuItems([{ id: "a", label: "" }])).toBeNull();
    expect(contextMenuItems([{ id: "", label: "A" }])).toBeNull();
    expect(contextMenuItems([{ id: "a", label: "A", click: "x", enabled: "yes" }])).toBeNull();
    expect(contextMenuItems([{ id: "a", label: "x".repeat(121) }])).toBeNull();
  });
});

describe("textMenuPopupOptions", () => {
  const window = { id: 1 } as unknown as BaseWindow;
  const frame = { routingId: 7 } as unknown as WebFrameMain;

  it("passes the event's frame, so macOS adds Writing Tools, AutoFill and Services", () => {
    const options = textMenuPopupOptions(window, { menuSourceType: "mouse", x: 10, y: 20, frame });
    expect(options.frame).toBe(frame);
    expect(options.window).toBe(window);
  });

  it("opens at the pointer for a click and at the field for the keyboard", () => {
    expect(textMenuPopupOptions(window, { menuSourceType: "mouse", x: 10, y: 20, frame })).toEqual({ window, frame });
    expect(textMenuPopupOptions(window, { menuSourceType: "keyboard", x: 10.4, y: 20, frame })).toEqual({
      window,
      frame,
      x: 10,
      y: 20,
    });
  });

  it("leaves the frame out when the event has none", () => {
    expect(textMenuPopupOptions(window, { menuSourceType: "mouse", x: 1, y: 2, frame: null })).toEqual({ window });
  });
});

describe("textMenuTemplate", () => {
  const all = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: true };
  const none = { ...all, canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canDelete: false };
  const params = (over: Partial<TextMenuParams> = {}): TextMenuParams => ({
    isEditable: true,
    selectionText: "",
    misspelledWord: "",
    dictionarySuggestions: [],
    formControlType: "input-text",
    editFlags: all,
    ...over,
  });
  const actions = { replace: vi.fn(), learn: vi.fn() };
  /** Label and whether it is on, a separator as "-". */
  const shown = (template: ReturnType<typeof textMenuTemplate>) =>
    template?.map((item) => (item.type === "separator" ? "-" : `${item.label}${item.enabled === false ? " (off)" : ""}`));

  it("gives a field the edit items, in Italian and in English, as roles", () => {
    expect(shown(textMenuTemplate(params(), "it", actions))).toEqual([
      "Annulla", "Ripeti", "-", "Taglia", "Copia", "Incolla", "-", "Seleziona tutto",
    ]);
    expect(shown(textMenuTemplate(params(), "en", actions))).toEqual([
      "Undo", "Redo", "-", "Cut", "Copy", "Paste", "-", "Select all",
    ]);
    expect(textMenuTemplate(params(), "it", actions)?.flatMap((item) => (item.role ? [item.role] : []))).toEqual([
      "undo", "redo", "cut", "copy", "paste", "selectAll",
    ]);
  });

  it("turns off each item the field cannot do now", () => {
    expect(shown(textMenuTemplate(params({ editFlags: { ...none, canSelectAll: false } }), "it", actions))).toEqual([
      "Annulla (off)", "Ripeti (off)", "-", "Taglia (off)", "Copia (off)", "Incolla (off)", "-", "Seleziona tutto (off)",
    ]);
    expect(shown(textMenuTemplate(params({ editFlags: { ...none, canUndo: true, canPaste: true } }), "en", actions))).toEqual([
      "Undo", "Redo (off)", "-", "Cut (off)", "Copy (off)", "Paste", "-", "Select all",
    ]);
  });

  it("leaves Taglia and Copia out of a password field", () => {
    expect(shown(textMenuTemplate(params({ formControlType: "input-password" }), "it", actions))).toEqual([
      "Annulla", "Ripeti", "-", "Incolla", "-", "Seleziona tutto",
    ]);
  });

  it("offers a misspelled word's suggestions first, then the dictionary", () => {
    const template = textMenuTemplate(
      params({ misspelledWord: "ciaoo", dictionarySuggestions: ["ciao", "ciaò", "caio", "ciaone", "ciaa", "ciao!"] }),
      "it",
      actions,
    );
    expect(shown(template)).toEqual([
      "ciao", "ciaò", "caio", "ciaone", "ciaa", "-", "Aggiungi al dizionario", "-",
      "Annulla", "Ripeti", "-", "Taglia", "Copia", "Incolla", "-", "Seleziona tutto",
    ]);
    template![1]!.click!({} as never, undefined, {} as never);
    expect(actions.replace).toHaveBeenCalledWith("ciaò");
    template![6]!.click!({} as never, undefined, {} as never);
    expect(actions.learn).toHaveBeenCalledWith("ciaoo");
  });

  it("says so when a misspelled word has no suggestion", () => {
    expect(shown(textMenuTemplate(params({ misspelledWord: "xqzv" }), "en", actions))?.slice(0, 4)).toEqual([
      "No suggestions (off)", "-", "Add to dictionary", "-",
    ]);
  });

  it("gives a read-only field Copia and Seleziona tutto, and a password one nothing to copy", () => {
    expect(shown(textMenuTemplate(params({ isEditable: false, formControlType: "text-area" }), "it", actions))).toEqual([
      "Copia", "Seleziona tutto",
    ]);
    expect(shown(textMenuTemplate(params({ isEditable: false, formControlType: "input-search", editFlags: { ...none, canSelectAll: true } }), "en", actions))).toEqual([
      "Copy (off)", "Select all",
    ]);
  });

  it("gives selected text outside a field Copia, and nothing without a selection", () => {
    const text = { isEditable: false, formControlType: "none" as const };
    expect(shown(textMenuTemplate(params({ ...text, selectionText: "il calore" }), "it", actions))).toEqual(["Copia"]);
    expect(textMenuTemplate(params({ ...text, selectionText: "  " }), "it", actions)).toBeNull();
    expect(textMenuTemplate(params({ ...text, formControlType: "input-checkbox" }), "it", actions)).toBeNull();
  });

  it("treats an editable area that is no input, such as a formula's text, like a field", () => {
    expect(shown(textMenuTemplate(params({ formControlType: "none" }), "en", actions))?.[0]).toBe("Undo");
  });
});
