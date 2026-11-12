import type { Session } from "electron";
import type { MenuLanguage } from "../shared/menu";

/**
 * Whether the spell checker follows the app's language instead of the computer's. It is off on purpose: on Windows and
 * Linux Chromium downloads each dictionary it needs from Google's servers (`redirector.gvt1.com`, one `.bdic` file per
 * language, once per profile), and following the app means fetching the Italian and English files even where the
 * computer's own language is something else. SECURITY.md lists every request the app makes, so the owner decides first
 * whether that download is allowed and whether it needs a row there and a consent step. Until then the checker keeps
 * Electron's default, the computer's language, which already downloads that one dictionary.
 */
export const SPELLCHECK_FOLLOWS_APP_LANGUAGE = false;

/** The dictionary codes Electron may offer for each language the app ships, the most specific first. */
const codes: Record<MenuLanguage, readonly string[]> = { it: ["it-IT", "it"], en: ["en-US", "en"] };

/**
 * The checker's languages for an app language: that language first, then the other one the app ships, each as the
 * first of its codes that `available` (`session.availableSpellCheckerLanguages`) lists. A code Electron does not know
 * would make `setSpellCheckerLanguages` throw, so it is left out.
 */
export function spellCheckerLanguages(language: MenuLanguage, available: readonly string[]): string[] {
  const other: MenuLanguage = language === "it" ? "en" : "it";
  return [language, other].flatMap((name) => {
    const code = codes[name].find((candidate) => available.includes(candidate));
    return code ? [code] : [];
  });
}

/**
 * Points the session's spell checker at the app's language and the other language the app ships. Returns the languages
 * it set, or null when it left the checker alone: the switch is off, the platform is macOS (the system's checker picks
 * its own languages there, and the call does nothing or throws), or Electron offers neither language.
 */
export function applySpellCheckerLanguages(
  session: Pick<Session, "availableSpellCheckerLanguages" | "setSpellCheckerLanguages">,
  language: MenuLanguage,
  platform: NodeJS.Platform = process.platform,
  enabled: boolean = SPELLCHECK_FOLLOWS_APP_LANGUAGE,
): string[] | null {
  if (!enabled || platform === "darwin") return null;
  const languages = spellCheckerLanguages(language, session.availableSpellCheckerLanguages);
  if (languages.length === 0) return null;
  session.setSpellCheckerLanguages(languages);
  return languages;
}
