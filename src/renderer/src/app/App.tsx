import { UpdateNotice } from "../features/settings/UpdatesPanel";
import { BackupNotice } from "../features/settings/AutoBackups";
import { App as AntApp, ConfigProvider } from "antd";
import { ProConfigProvider } from "@ant-design/pro-components";
import enUS from "antd/locale/en_US";
import itIT from "antd/locale/it_IT";
import { Calendar, ChevronDown, LoaderCircle } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RouterProvider } from "react-router";
import type { Appearance, ThemeSource } from "@shared/bridge";
import { pyxisTheme } from "../design-system/theme/pyxis-theme";
import type { Locale } from "../locales/i18n";
import { CoreNotice } from "./CoreNotice";
import { EngineFallbackNotice } from "./EngineFallbackNotice";
import { MenuCommands } from "./MenuCommands";
import { OpenedPlans } from "./OpenedPlans";
import { MakeCardsDialog } from "../components/MakeCardsDialog";
import { SourceViewer } from "../components/SourceViewer";
import { JobsSync } from "../features/jobs/queries";
import { AppStateContext } from "./app-state";
import { router } from "./router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { profileQuery } from "../lib/queries";

// Only the print window shows it, and it waits for the page to say it is ready.
const PrintPage = lazy(() =>
  import("../features/share/PrintPage").then((module) => ({ default: module.PrintPage })),
);

export function App() {
  return window.location.hash.startsWith("#/print") ? (
    <Suspense fallback={null}>
      <PrintPage />
    </Suspense>
  ) : (
    <StudyApp />
  );
}

// Lucide in place of antd's own chevron and calendar on every Select and date field (range pickers read the
// date picker's setting), set once for the app.
const selectIcons = {
  suffixIcon: <ChevronDown size={16} strokeWidth={1.75} aria-hidden />,
};
const dateIcons = {
  suffixIcon: <Calendar size={16} strokeWidth={1.75} aria-hidden />,
};
/**
 * antd's own spinner is an image named "loading", so a busy button was called "loading Save", and kept that name until
 * the spinner's exit motion ended, which a hidden or slow window can delay. This one is no part of the name.
 */
const buttonIcons = {
  loadingIcon: <LoaderCircle size={16} strokeWidth={1.75} aria-hidden className="px-spin" />,
};

function StudyApp() {
  const { i18n } = useTranslation();
  const locale: Locale = i18n.language === "en" ? "en" : "it";
  const [appearance, setAppearance] = useState<Appearance>({
    source: "system",
    resolved: "dark",
  });
  const [ready, setReady] = useState(false);
  const client = useQueryClient();
  const profile = useQuery({ ...profileQuery, retry: 10, retryDelay: 300 });
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
        select={selectIcons}
        datePicker={dateIcons}
        button={buttonIcons}
      >
        <ProConfigProvider dark={appearance.resolved === "dark"} hashed={false}>
          <AntApp>
            <JobsSync />
            <div className="px-corner-notices">
              <BackupNotice />
              <UpdateNotice />
            </div>
            <CoreNotice />
            <EngineFallbackNotice />
            <MenuCommands />
            <OpenedPlans />
            <RouterProvider router={router} />
            <SourceViewer />
            <MakeCardsDialog />
          </AntApp>
        </ProConfigProvider>
      </ConfigProvider>
    </AppStateContext.Provider>
  );
}
