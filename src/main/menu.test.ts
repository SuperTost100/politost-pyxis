import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { goPages, isMenuCommand, type MenuCommand } from "../shared/menu";
import { buildMenuTemplate } from "./menu";

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
    ).toEqual(["Chiedi", "Esami", "Libreria", "Flashcard", "Mappe", "Indietro"]);
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
