import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow } from "electron";
import { APP_SCHEME } from "./app-protocol";

/**
 * Up to 0.3.1 the window loaded from file://, so what the renderer keeps in localStorage (the interface language,
 * dismissed notices, page settings) belongs to that origin, which the pyxis-app origin cannot read. On the first
 * launch after the update a hidden window reads every key from a file:// page and writes the ones the new origin
 * lacks from a pyxis-app page. Both pages are a stylesheet shown as text, without the preload. `marker` records that
 * the copy ran, so it runs once. `open` runs before the hidden window closes: with no window left, the app would quit.
 */
export async function carryStorage(
  marker: string,
  userData: string,
  rendererRoot: string,
  open: () => void,
): Promise<void> {
  if (existsSync(marker)) return open();
  // Only a profile whose window an earlier version opened (and saved the size of) has anything to carry.
  if (!existsSync(join(userData, "window.json"))) {
    save(marker, 0);
    return open();
  }
  const probe = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  let carried = 0;
  let timer: NodeJS.Timeout | undefined;
  try {
    const stylesheet = readdirSync(join(rendererRoot, "assets")).find((name) =>
      name.endsWith(".css"),
    );
    if (!stylesheet) throw new Error("no stylesheet");
    const copy = (async () => {
      await probe.loadFile(join(rendererRoot, "assets", stylesheet));
      const entries = (await probe.webContents.executeJavaScript(
        "Object.entries(localStorage)",
      )) as unknown;
      if (!Array.isArray(entries) || entries.length === 0) return 0;
      await probe.loadURL(`${APP_SCHEME}://app/assets/${stylesheet}`);
      // A key the new origin already has is newer than the old copy and stays.
      return (await probe.webContents.executeJavaScript(
        `(${(old: [string, string][]) => {
          let written = 0;
          for (const [key, value] of old)
            if (typeof key === "string" && typeof value === "string" && localStorage.getItem(key) === null) {
              localStorage.setItem(key, value);
              written++;
            }
          return written;
        }})(${JSON.stringify(entries)})`,
      )) as number;
    })();
    carried = await Promise.race([
      copy,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), 5000);
      }),
    ]);
  } catch (error) {
    // The window then starts like a new profile's, in the system language.
    console.error(
      "pyxis: could not carry settings from the previous version",
      error instanceof Error ? error.message : "unknown",
    );
  } finally {
    clearTimeout(timer);
  }
  save(marker, carried);
  try {
    open();
  } finally {
    probe.destroy();
  }
}

function save(marker: string, keys: number): void {
  try {
    writeFileSync(marker, JSON.stringify({ keys }));
  } catch (error) {
    console.error(
      "pyxis: could not record the carried settings",
      error instanceof Error ? error.message : "unknown",
    );
  }
}
