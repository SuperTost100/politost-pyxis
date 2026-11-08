import dayjs from "dayjs";
import "dayjs/locale/it";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import it from "./it.json";

export type Locale = "it" | "en";

// i18next 27 turns strictInterpolationChecks on by default. The resources here are not typed, so keys are plain
// strings and the check has no variables to compare. It does change t's signature, though, so helpers typed as
// `(key, params?) => string` no longer accept t. False keeps the i18next 26 signature.
declare module "i18next" {
  interface CustomTypeOptions {
    strictInterpolationChecks: false;
  }
}

const STORAGE_KEY = "pyxis.lang";

function storedLocale(): Locale {
  const value = localStorage.getItem(STORAGE_KEY);
  if (value === "en" || value === "it") return value;
  return window.pyxis.systemLanguage;
}

// The one place that sets the page language; English is dayjs's built-in locale.
function applyLocale(lng: string): void {
  const locale: Locale = lng === "en" ? "en" : "it";
  document.documentElement.lang = locale;
  dayjs.locale(locale);
}

void i18n.use(initReactI18next).init({
  resources: {
    it: { translation: it },
    en: { translation: en },
  },
  lng: storedLocale(),
  fallbackLng: "it",
  interpolation: { escapeValue: false },
});

applyLocale(i18n.language);
i18n.on("languageChanged", applyLocale);

export function setLanguage(lng: Locale): void {
  localStorage.setItem(STORAGE_KEY, lng);
  void i18n.changeLanguage(lng);
}

export { i18n };
