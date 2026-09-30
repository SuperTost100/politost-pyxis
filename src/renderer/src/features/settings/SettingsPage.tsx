import { useTranslation } from "react-i18next";
import { useAppState } from "../../app/app-state";
import { i18n, setLanguage, type Locale } from "../../locales/i18n";
import { EnginesPanel } from "./EnginesPanel";

export function SettingsPage() {
  const { t } = useTranslation();
  const { appearance, setTheme } = useAppState();
  const locale: Locale = i18n.language === "en" ? "en" : "it";
  return (
    <div>
      <h1 className="title-1">{t("settings.title")}</h1>
      <div className="label section-label">{t("settings.appearance")}</div>
      <div className="choice-list">
        <Choice
          label={t("settings.system")}
          selected={appearance.source === "system"}
          onClick={() => void setTheme("system")}
        />
        <Choice
          label={t("settings.dark")}
          selected={appearance.source === "dark"}
          onClick={() => void setTheme("dark")}
        />
        <Choice
          label={t("settings.light")}
          selected={appearance.source === "light"}
          onClick={() => void setTheme("light")}
        />
      </div>
      {appearance.source === "system" ? (
        <p className="small section-hint">{t("settings.themeHint")}</p>
      ) : null}
      <EnginesPanel />
      <div className="label section-label">{t("settings.language")}</div>
      <div className="choice-list">
        <Choice
          label={t("settings.italian")}
          selected={locale === "it"}
          onClick={() => setLanguage("it")}
        />
        <Choice
          label={t("settings.english")}
          selected={locale === "en"}
          onClick={() => setLanguage("en")}
        />
      </div>
    </div>
  );
}

function Choice(props: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={props.selected ? "choice is-selected" : "choice"}
      aria-pressed={props.selected}
      onClick={props.onClick}
    >
      <span className="body-strong">{props.label}</span>
    </button>
  );
}
