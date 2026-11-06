import type { ElectronApplication } from "@playwright/test";

/**
 * Answers the next system context menu main shows: picks the item labelled `label` (any of them, for a test that runs
 * in both languages), or closes the menu without a pick when `label` is null. A real native menu can't be clicked from a test, so this stands in for the click, once.
 */
export async function answerNextMenu(app: ElectronApplication, label: string | string[] | null): Promise<void> {
  const labels = label === null ? [] : Array.isArray(label) ? label : [label];
  await app.evaluate(({ Menu }, labels) => {
    const shown = globalThis as unknown as { menuLabels?: string[] };
    const build = Menu.buildFromTemplate.bind(Menu);
    // Menus built meanwhile without popping up, like the app menu after a language change, are left alone.
    Menu.buildFromTemplate = (template) => {
      const menu = build(template);
      menu.popup = (options) => {
        Menu.buildFromTemplate = build;
        shown.menuLabels = template.map((item) => item.label ?? "-");
        const item = template.find((entry) => entry.label !== undefined && labels.includes(entry.label));
        (item?.click as (() => void) | undefined)?.();
        options?.callback?.();
      };
      return menu;
    };
  }, labels);
}

/** The labels of the last context menu `answerNextMenu` answered, a separator as "-". */
export function lastMenuLabels(app: ElectronApplication): Promise<string[] | undefined> {
  return app.evaluate(() => (globalThis as unknown as { menuLabels?: string[] }).menuLabels);
}
