import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow } from "electron";

type Language = "it" | "en" | null;

/**
 * Up to 0.3.1 the window loaded from file://, so the interface language a student picked is in that origin's
 * localStorage, which the pyxis-app origin cannot read. On the first launch after the update, main reads it from a
 * hidden file:// page (a stylesheet shown as text, without the preload) and keeps the answer in `file`. `open` gets
 * the language, or null when there was no choice, and runs before the hidden page closes: with no window left, the
 * app would quit.
 */
export async function carryLanguage(
  file: string,
  userData: string,
  rendererRoot: string,
  open: (language: Language) => void,
): Promise<void> {
  const saved = readCarried(file);
  if (saved !== undefined) return open(saved);
  // Only a profile whose window an earlier version opened (and saved the size of) can have a choice to carry.
  if (!existsSync(join(userData, "window.json"))) {
    save(file, null);
    return open(null);
  }
  const probe = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  let language: Language = null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const stylesheet = readdirSync(join(rendererRoot, "assets")).find((name) =>
      name.endsWith(".css"),
    );
    if (!stylesheet) throw new Error("no stylesheet");
    const read = (async () => {
      await probe.loadFile(join(rendererRoot, "assets", stylesheet));
      return (await probe.webContents.executeJavaScript(
        'localStorage.getItem("pyxis.lang")',
      )) as unknown;
    })();
    const value = await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), 5000);
      }),
    ]);
    if (value === "it" || value === "en") language = value;
  } catch (error) {
    // The window then starts in the system language, as a new profile does.
    console.error(
      "pyxis: could not read the previous interface language",
      error instanceof Error ? error.message : "unknown",
    );
  } finally {
    clearTimeout(timer);
  }
  save(file, language);
  try {
    open(language);
  } finally {
    probe.destroy();
  }
}

function save(file: string, language: Language): void {
  try {
    writeFileSync(file, JSON.stringify({ language }));
  } catch (error) {
    console.error(
      "pyxis: could not save the interface language",
      error instanceof Error ? error.message : "unknown",
    );
  }
}

/** The saved answer, or undefined when the language was never carried. */
function readCarried(file: string): Language | undefined {
  try {
    const { language } = JSON.parse(readFileSync(file, "utf8")) as {
      language?: unknown;
    };
    if (language === "it" || language === "en" || language === null)
      return language;
  } catch {
    // Not carried yet.
  }
  return undefined;
}
