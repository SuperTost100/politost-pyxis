import type { ElectronApplication } from "@playwright/test";

/**
 * Answers the next system context menu main shows: picks the item labelled `label` (any of them, for a test that runs
 * in both languages), or closes the menu without a pick when `label` is null. A real native menu can't be clicked from a test, so this stands in for the click, once.
 */
export async function answerNextMenu(app: ElectronApplication, label: string | string[] | null): Promise<void> {
  const labels = label === null ? [] : Array.isArray(label) ? label : [label];
  await app.evaluate(({ Menu }, labels) => {
    const shown = globalThis as unknown as { menuLabels?: string[]; menuAt?: { x: number; y: number } };
    const build = Menu.buildFromTemplate.bind(Menu);
    // Menus built meanwhile without popping up, like the app menu after a language change, are left alone.
    Menu.buildFromTemplate = (template) => {
      const menu = build(template);
      menu.popup = (options) => {
        Menu.buildFromTemplate = build;
        shown.menuLabels = template.map((item) => item.label ?? "-");
        shown.menuAt = options?.x === undefined ? undefined : { x: options.x, y: options.y ?? 0 };
        const item = template.find((entry) => entry.label !== undefined && labels.includes(entry.label));
        (item?.click as (() => void) | undefined)?.();
        options?.callback?.();
      };
      return menu;
    };
  }, labels);
}

/** Where the last context menu `answerNextMenu` answered was asked to open, or undefined at the pointer. */
export function lastMenuAt(app: ElectronApplication): Promise<{ x: number; y: number } | undefined> {
  return app.evaluate(() => (globalThis as unknown as { menuAt?: { x: number; y: number } }).menuAt);
}

/** The labels of the last context menu `answerNextMenu` answered, a separator as "-". */
export function lastMenuLabels(app: ElectronApplication): Promise<string[] | undefined> {
  return app.evaluate(() => (globalThis as unknown as { menuLabels?: string[] }).menuLabels);
}
