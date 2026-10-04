import { Button, Segmented } from "antd";
import { PageContainer, ProLayout } from "@ant-design/pro-components";
import { GraduationCap, MessageCircle, Settings } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate } from "react-router";
import logoDark from "../../design-system/logo/pyxis-lockup-dark.svg";
import logoLight from "../../design-system/logo/pyxis-lockup-light.svg";
import { pyxisProLayoutToken } from "../../design-system/theme/pyxis-theme";
import { JobsButton } from "../../features/jobs/JobsButton";
import { invoke } from "../../lib/ipc";
import { useAppState } from "../app-state";

type Door = "ask" | "exams";

const LAST_KEY = "pyxis.lastDoorPath";
const DOOR_KEY = "pyxis.door";

function readLast(): Record<Door, string> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(LAST_KEY) ?? "") as Partial<
      Record<Door, string>
    >;
    return { ask: raw.ask || "/ask", exams: raw.exams || "/exams" };
  } catch {
    return { ask: "/ask", exams: "/exams" };
  }
}

function doorForPath(pathname: string, stored: Door): Door {
  if (pathname.startsWith("/ask")) return "ask";
  if (pathname.startsWith("/exams") || pathname.startsWith("/plans"))
    return "exams";
  return stored;
}

export function Shell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const client = useQueryClient();
  const { appearance } = useAppState();
  const mode = appearance.resolved;
  const [last, setLast] = useState(readLast);
  const [storedDoor, setStoredDoor] = useState<Door>(() =>
    sessionStorage.getItem(DOOR_KEY) === "ask" ? "ask" : "exams",
  );
  const activeDoor = doorForPath(location.pathname, storedDoor);
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => invoke("profile.get", {}),
    retry: 10,
    retryDelay: 300,
  });

  const activeSimulation = useQuery({
    queryKey: ["active-simulation"],
    queryFn: () => invoke("study.activeSimulation", {}),
    enabled: profile.isSuccess && Boolean(profile.data),
    refetchInterval: 1000,
  });
  useEffect(() => {
    if (activeSimulation.data && location.pathname.startsWith("/ask"))
      navigate(
        `/plans/${activeSimulation.data.planId}/exam/${activeSimulation.data.attemptId}`,
        { replace: true },
      );
  }, [activeSimulation.data, location.pathname, navigate]);

  useEffect(() => {
    for (const header of document.querySelectorAll(
      "header.ant-layout-header",
    )) {
      if (header instanceof HTMLElement && header.childElementCount === 0) {
        header.setAttribute("role", "presentation");
      }
    }
  });

  useEffect(() => {
    if (profile.isSuccess) return;
    return window.pyxis.onPort(() => {
      void client.invalidateQueries({ queryKey: ["profile"] });
    });
  }, [client, profile.isSuccess]);

  useEffect(() => {
    if (!profile.isSuccess || profile.data) return;
    if (location.pathname.startsWith("/onboarding")) return;
    navigate("/onboarding");
  }, [profile.isSuccess, profile.data, location.pathname, navigate]);

  useEffect(() => {
    const door = doorForPath(location.pathname, storedDoor);
    if (
      location.pathname.startsWith("/ask") ||
      location.pathname.startsWith("/exams") ||
      location.pathname.startsWith("/plans")
    ) {
      const next = { ...readLast(), [door]: location.pathname };
      sessionStorage.setItem(LAST_KEY, JSON.stringify(next));
      sessionStorage.setItem(DOOR_KEY, door);
      setLast(next);
      setStoredDoor(door);
    }
  }, [location.pathname, storedDoor]);

  return (
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
          style={{ display: "flex", justifyContent: "center", width: "100%" }}
        >
          <div
            onClick={(event) => {
              const item = (event.target as HTMLElement).closest(
                ".ant-segmented-item",
              );
              if (!item?.classList.contains("ant-segmented-item-selected"))
                return;
              const text = item.textContent ?? "";
              if (text.includes(t("doors.ask"))) navigate(last.ask);
              else if (text.includes(t("doors.exams"))) navigate(last.exams);
            }}
          >
            <Segmented<Door>
              shape="round"
              className="px-doors"
              value={activeSimulation.data ? "exams" : activeDoor}
              onChange={(value) =>
                navigate(value === "ask" ? last.ask : last.exams)
              }
              options={[
                ...(!activeSimulation.data
                  ? [
                      {
                        value: "ask" as const,
                        label: t("doors.ask"),
                        icon: <MessageCircle size={16} strokeWidth={1.75} />,
                      },
                    ]
                  : []),
                {
                  value: "exams",
                  label: t("doors.exams"),
                  icon: <GraduationCap size={16} strokeWidth={1.75} />,
                },
              ]}
            />
          </div>
        </div>
      )}
      actionsRender={() => [
        <JobsButton key="jobs" />,
        <Button
          key="settings"
          shape="circle"
          type="text"
          aria-label={t("nav.settings")}
          icon={<Settings size={18} strokeWidth={1.75} />}
          onClick={() => navigate("/settings")}
        />,
      ]}
      footerRender={false}
    >
      <PageContainer
        header={{ title: false, breadcrumb: {} }}
        style={{ maxWidth: 768, margin: "0 auto" }}
      >
        <div className="shell-page">
          {activeSimulation.data ? (
            <Button
              shape="round"
              onClick={() =>
                navigate(
                  `/plans/${activeSimulation.data!.planId}/exam/${activeSimulation.data!.attemptId}`,
                )
              }
            >
              {t("simulation.resume")}
            </Button>
          ) : null}
          <Outlet />
        </div>
      </PageContainer>
    </ProLayout>
  );
}
