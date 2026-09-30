// PoliTost Pyxis — app shell on Ant Design Pro (ProComponents v3) + antd v6.
// Astra-style top header: logo left, Chiedi / Esami doors centred, settings right.
// One centred column of 768px (content-width). No sidebar.
import * as React from "react";
import { ConfigProvider, App as AntApp, Segmented, Button } from "antd";
import {
  ProConfigProvider,
  ProLayout,
  PageContainer,
} from "@ant-design/pro-components";
import itIT from "antd/locale/it_IT";
import enUS from "antd/locale/en_US";
import { MessageCircle, GraduationCap, Settings } from "lucide-react";
import { pyxisTheme, pyxisProLayoutToken, type PyxisMode } from "./pyxis-theme";
import logoDark from "../logo/pyxis-lockup-dark.svg";
import logoLight from "../logo/pyxis-lockup-light.svg";

type Door = "ask" | "exams";

export function AppShell(props: {
  mode: PyxisMode;
  lang: "it" | "en";
  door: Door;
  onDoor: (d: Door) => void;
  onSettings: () => void;
  children: React.ReactNode;
}) {
  const { mode, lang, door } = props;
  React.useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);
  const t =
    lang === "it"
      ? { ask: "Chiedi", exams: "Esami", settings: "Impostazioni" }
      : { ask: "Ask", exams: "Exams", settings: "Settings" };
  return (
    <ConfigProvider
      theme={pyxisTheme(mode)}
      locale={lang === "it" ? itIT : enUS}
    >
      <ProConfigProvider dark={mode === "dark"} hashed={false}>
        <AntApp>
          <ProLayout
            layout="top"
            contentWidth="Fixed"
            fixedHeader
            navTheme={mode === "dark" ? "realDark" : "light"}
            token={pyxisProLayoutToken(mode)}
            title={false}
            logo={
              <img
                src={mode === "dark" ? logoDark : logoLight}
                alt="Pyxis"
                height={28}
              />
            }
            menuRender={false}
            headerContentRender={() => (
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  width: "100%",
                }}
              >
                <Segmented<Door>
                  shape="round"
                  className="px-doors"
                  value={door}
                  onChange={props.onDoor}
                  options={[
                    {
                      value: "ask",
                      label: t.ask,
                      icon: <MessageCircle size={16} strokeWidth={1.75} />,
                    },
                    {
                      value: "exams",
                      label: t.exams,
                      icon: <GraduationCap size={16} strokeWidth={1.75} />,
                    },
                  ]}
                />
              </div>
            )}
            actionsRender={() => [
              <Button
                key="settings"
                shape="circle"
                type="text"
                aria-label={t.settings}
                icon={<Settings size={18} strokeWidth={1.75} />}
                onClick={props.onSettings}
              />,
            ]}
            footerRender={false}
          >
            <PageContainer
              header={{ title: false, breadcrumb: {} }}
              style={{ maxWidth: 768, margin: "0 auto" }}
            >
              {props.children}
            </PageContainer>
          </ProLayout>
        </AntApp>
      </ProConfigProvider>
    </ConfigProvider>
  );
}
