import { Button } from "antd";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router";
import type { Locale } from "../../locales/i18n";
import { i18n } from "../../locales/i18n";
import { useAppState } from "../../app/app-state";
import type { ThemeSource } from "@shared/bridge";
import { SegmentedTabs } from "../../components/SegmentedTabs";
import { invoke } from "../../lib/ipc";
import { ComponentGallery } from "./ComponentGallery";
import "./DevGallery.css";

export function DevGallery() {
  const { t } = useTranslation();
  const { appearance, setTheme } = useAppState();
  if (!window.pyxis.dev) return <Navigate to="/exams" replace />;

  const start = useMutation({
    mutationFn: (failOnce: boolean) => invoke("jobs.startDemo", { failOnce }),
  });

  const themeValue =
    appearance.source === "system" ? "system" : appearance.resolved;
  const localeValue: Locale = i18n.language === "en" ? "en" : "it";

  return (
    <div className="column gallery-page shell-page">
      <p className="label">{t("dev.kicker")}</p>
      <h1 className="title-1">{t("dev.title")}</h1>
      <p className="body">{t("dev.intro")}</p>

      <div className="gallery-toolbar">
        <SegmentedTabs
          label={t("dev.themeLabel")}
          value={themeValue}
          onChange={(v) => setTheme(v as ThemeSource)}
          items={[
            { value: "system", label: t("settings.system") },
            { value: "dark", label: t("settings.dark") },
            { value: "light", label: t("settings.light") },
          ]}
        />
        <SegmentedTabs
          label={t("dev.languageLabel")}
          value={localeValue}
          onChange={(v) => void i18n.changeLanguage(v)}
          items={[
            { value: "it", label: t("settings.italian") },
            { value: "en", label: t("settings.english") },
          ]}
        />
      </div>

      <section className="gallery-demo-job">
        <h2 className="title-2">{t("dev.demoJobTitle")}</h2>
        <p className="body">{t("dev.demoJobBody")}</p>
        <div className="gallery-row">
          <Button type="primary" shape="round" onClick={() => start.mutate(false)}>
            {t("dev.start")}
          </Button>
          <Button shape="round" onClick={() => start.mutate(true)}>
            {t("dev.fail")}
          </Button>
          <Button shape="round" onClick={() => void window.pyxis.killCore()}>
            {t("dev.kill")}
          </Button>
        </div>
      </section>

      <ComponentGallery />
    </div>
  );
}
