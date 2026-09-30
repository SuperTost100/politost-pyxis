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
import { AppStateContext } from "./app-state";
import { router } from "./router";

export function App() {
  const { i18n: i18nInstance } = useTranslation();
  const locale: Locale = i18nInstance.language === "en" ? "en" : "it";
  const [appearance, setAppearance] = useState<Appearance>({
    source: "system",
    resolved: "dark",
  });
  const [ready, setReady] = useState(false);

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
        theme={pyxisTheme(appearance.resolved)}
        locale={locale === "it" ? itIT : enUS}
      >
        <ProConfigProvider dark={appearance.resolved === "dark"} hashed={false}>
          <AntApp>
            <RouterProvider router={router} />
          </AntApp>
        </ProConfigProvider>
      </ConfigProvider>
    </AppStateContext.Provider>
  );
}
