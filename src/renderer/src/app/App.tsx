import { UpdateNotice } from "../features/settings/UpdatesPanel";
import { PrintPage } from "../features/share/PrintPage";
import { App as AntApp, ConfigProvider } from "antd";
import { ProConfigProvider } from "@ant-design/pro-components";
import enUS from "antd/locale/en_US";
import itIT from "antd/locale/it_IT";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RouterProvider } from "react-router";
import type { Appearance, ThemeSource } from "@shared/bridge";
import { pyxisTheme } from "../design-system/theme/pyxis-theme";
import { i18n, type Locale } from "../locales/i18n";
import { CoreNotice } from "./CoreNotice";
import { SourceViewer } from "../components/SourceViewer";
import { JobsSync } from "../features/jobs/queries";
import { AppStateContext } from "./app-state";
import { router } from "./router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "../lib/ipc";

export function App() {
  return window.location.hash.startsWith("#/print") ? (
    <PrintPage />
  ) : (
    <StudyApp />
  );
}

function StudyApp() {
  const { i18n: i18nInstance } = useTranslation();
  const locale: Locale = i18nInstance.language === "en" ? "en" : "it";
  const [appearance, setAppearance] = useState<Appearance>({
    source: "system",
    resolved: "dark",
  });
  const [ready, setReady] = useState(false);
  const client = useQueryClient();
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => invoke("profile.get", {}),
    retry: 10,
    retryDelay: 300,
  });
  useEffect(
    () =>
      window.pyxis.onPort(() => {
        void client.invalidateQueries({ queryKey: ["profile"] });
      }),
    [client],
  );
  useEffect(() => {
    document.documentElement.dataset.dyslexia = profile.data?.dyslexia
      ? "on"
      : "off";
    document.documentElement.dataset.text = profile.data?.textSize ?? "md";
  }, [profile.data]);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.platform = window.pyxis.platform;
    void window.pyxis.getAppearance().then((value) => {
      applyTheme(value);
      setReady(true);
    });
    return window.pyxis.onAppearance(applyTheme);
  }, []);

  function applyTheme(value: Appearance) {
    setAppearance(value);
    document.documentElement.dataset.theme = value.resolved;
  }

  async function setTheme(source: ThemeSource) {
    applyTheme(await window.pyxis.setAppearance(source));
  }

  useEffect(() => {
    const onLanguage = () => {
      document.documentElement.lang = i18n.language === "en" ? "en" : "it";
    };
    i18n.on("languageChanged", onLanguage);
    return () => i18n.off("languageChanged", onLanguage);
  }, []);

  if (!ready) return null;

  return (
    <AppStateContext.Provider value={{ appearance, setTheme }}>
      <ConfigProvider
        theme={pyxisTheme(
          appearance.resolved,
          reducedMotion,
          profile.data?.textSize === "lg"
            ? 1.12
            : profile.data?.textSize === "sm"
              ? 0.94
              : 1,
        )}
        locale={locale === "it" ? itIT : enUS}
      >
        <ProConfigProvider dark={appearance.resolved === "dark"} hashed={false}>
          <AntApp>
            <JobsSync />
            <UpdateNotice />
            <CoreNotice />
            <RouterProvider router={router} />
            <SourceViewer />
          </AntApp>
        </ProConfigProvider>
      </ConfigProvider>
    </AppStateContext.Provider>
  );
}
