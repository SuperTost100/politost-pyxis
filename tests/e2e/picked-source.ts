import type { ElectronApplication, Page } from "@playwright/test";

/** Test fixture still travels through main's native picker and grant acknowledgement. */
export async function importPickedSource(
  page: Page,
  app: ElectronApplication,
  path: string,
) {
  await app.evaluate(({ dialog }, selected) => {
    delete process.env.PYXIS_E2E_FILE;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
  }, path);
  return page.evaluate(async () => {
    const selected = await window.pyxis.showOpenDialog({
      properties: ["openFile"],
    });
    if (!selected?.[0]) throw new Error("fixture-picker-cancelled");
    return window.pyxis.invoke("sources.import", { path: selected[0] });
  });
}
