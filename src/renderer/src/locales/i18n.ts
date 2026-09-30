import dayjs from "dayjs";
import "dayjs/locale/en";
import "dayjs/locale/it";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import it from "./it.json";

export type Locale = "it" | "en";

const STORAGE_KEY = "pyxis.lang";

function storedLocale(): Locale {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === "en" ? "en" : "it";
}

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
