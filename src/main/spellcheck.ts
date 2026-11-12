import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "electron";
import type { MenuLanguage } from "../shared/menu";

/**
 * The Hunspell dictionaries Pyxis ships, by checker language: Chromium's files for Electron 45 (resources/dictionaries
 * says where they come from and under which licences). Chromium looks for each under this exact name, which carries
 * the dictionary's format version, in the profile's `Dictionaries` folder, and downloads it when it is not there.
 */
export const BUNDLED_DICTIONARIES = {
  "it-IT": { file: "it-IT-3-0.bdic", sha256: "8b83a0d4bba4cfcd4a4e7ee89b703014a00a5c08e721e568a5c552a732827fff" },
  "en-US": { file: "en-US-10-2.bdic", sha256: "b0d80e6b6c5491879365e176ecbd98074602a663429bcfcfb0a5a8375c051f13" },
} as const;

/**
 * Where Chromium would download a missing dictionary from, instead of Google's servers. Its loader for the browser
 * process refuses `file:` URLs, so a download fails at once without a request: a language Pyxis does not ship, or a
 * shipped file that is missing or damaged (Chromium deletes a file that fails its check), is simply not checked. The
 * host is empty, so on Windows the URL can never name a network share either.
 */
export const NO_DOWNLOAD_URL = "file:///pyxis-ships-its-dictionaries/";

/** The checker's language for each language the app ships. */
const codes: Record<MenuLanguage, keyof typeof BUNDLED_DICTIONARIES> = { it: "it-IT", en: "en-US" };

/**
 * The checker's languages for an app language: that language first, then the other one the app ships. A code missing
 * from `available` (`session.availableSpellCheckerLanguages`) would make `setSpellCheckerLanguages` throw, so it is
 * left out.
 */
export function spellCheckerLanguages(language: MenuLanguage, available: readonly string[]): string[] {
  const other: MenuLanguage = language === "it" ? "en" : "it";
  return [codes[language], codes[other]].filter((code) => available.includes(code));
}

/**
 * Copies the shipped dictionaries into the profile's `Dictionaries` folder (`app.getPath("sessionData")`), where
 * Chromium looks before it downloads, unless an identical copy is already there. Runs before the app is ready, ahead of
 * the session's first look. A file that can't be copied is logged and skipped: that language goes unchecked. Returns
 * the files it copied. Not on macOS, which uses the system's checker and ships no dictionaries.
 */
export function seedDictionaries(
  bundled: string,
  sessionData: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "darwin") return [];
  const target = join(sessionData, "Dictionaries");
  const copied: string[] = [];
  for (const { file } of Object.values(BUNDLED_DICTIONARIES)) {
    try {
      const source = readFileSync(join(bundled, file));
      let current: Buffer | null = null;
      try {
        current = readFileSync(join(target, file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (current?.equals(source)) continue;
      mkdirSync(target, { recursive: true });
      copyFileSync(join(bundled, file), join(target, file));
      copied.push(file);
    } catch (error) {
      console.error(
        `pyxis: spelling dictionary ${file} not installed`,
        (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.name : "unknown"),
      );
    }
  }
  return copied;
}

/**
 * Sets the session's spell checker up so that it never downloads: the download URL points at `NO_DOWNLOAD_URL`, and
 * the languages are the app's language and the other one the app ships, whose files `seedDictionaries` put in place.
 * Main calls it as soon as the app is ready, before any page, and again when the interface language changes. Returns
 * the languages it set, or null on macOS, where the system's checker picks its own languages and both calls do nothing.
 */
export function applySpellCheckerLanguages(
  session: Pick<
    Session,
    "availableSpellCheckerLanguages" | "setSpellCheckerLanguages" | "setSpellCheckerDictionaryDownloadURL"
  >,
  language: MenuLanguage,
  platform: NodeJS.Platform = process.platform,
): string[] | null {
  if (platform === "darwin") return null;
  session.setSpellCheckerDictionaryDownloadURL(NO_DOWNLOAD_URL);
  const languages = spellCheckerLanguages(language, session.availableSpellCheckerLanguages);
  session.setSpellCheckerLanguages(languages);
  return languages;
}
