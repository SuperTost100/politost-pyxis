import { Button, Segmented } from "antd";
import { PageContainer, ProLayout } from "@ant-design/pro-components";
import { GraduationCap, MessageCircle, Network, Settings } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate, useNavigation } from "react-router";
import logoDark from "../../design-system/logo/pyxis-lockup-dark.svg";
import logoLight from "../../design-system/logo/pyxis-lockup-light.svg";
import { pyxisProLayoutToken } from "../../design-system/theme/pyxis-theme";
import { JobsButton } from "../../features/jobs/JobsButton";
import { invoke } from "../../lib/ipc";
import { useAppState } from "../app-state";
import { LaunchEngineNotice } from "../LaunchEngineNotice";
import { useMenuLock } from "../menu-state";

type Door = "ask" | "exams" | "maps";

const doorRoots: Record<Door, string> = {
  ask: "/ask",
  exams: "/exams",
  maps: "/maps",
};

const LAST_KEY = "pyxis.lastDoorPath";

function readLast(): Record<Door, string> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(LAST_KEY) ?? "") as Partial<
      Record<Door, string>
    >;
    return {
      ask: raw.ask || doorRoots.ask,
      exams: raw.exams || doorRoots.exams,
      maps: raw.maps || doorRoots.maps,
    };
  } catch {
    return { ...doorRoots };
  }
}

/** Settings and dev pages belong to no door, so neither door is selected there. */
function doorForPath(pathname: string): Door | null {
  if (pathname.startsWith("/ask")) return "ask";
  if (pathname.startsWith("/exams") || pathname.startsWith("/plans"))
    return "exams";
  if (pathname.startsWith("/maps")) return "maps";
  return null;
}

/**
 * Records `pathname` as where its door was left. The router calls it on every navigation it finishes, not a render
 * effect: React can skip the render of a page the student passed through quickly, and the door would then remember a
 * page left earlier.
 */
export function rememberDoorPath(pathname: string): void {
  const door = doorForPath(pathname);
  if (!door) return;
  sessionStorage.setItem(
    LAST_KEY,
    JSON.stringify({ ...readLast(), [door]: pathname }),
  );
}

/** Where a door leads from `pathname`: back to where it was left, or to its root when it is already open. */
export function doorTarget(door: Door, pathname: string): string {
  if (doorForPath(pathname) === door) return doorRoots[door];
  return readLast()[door];
}

/** antd's Segmented shows no selection when its value matches no option. */
const NO_DOOR = "" as Door;

export function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  // A page loads on its first visit, and the previous one stays until it has. The column and the highlighted door
  // follow the page being opened from the start, so they never depend on how long that takes.
  const target = useNavigation().location ?? location;
  const client = useQueryClient();
  const { appearance } = useAppState();
  const mode = appearance.resolved;
  const activeDoor = doorForPath(target.pathname);
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => invoke("profile.get", {}),
    retry: 10,
    retryDelay: 300,
  });

  // Setup is a closed flow: no section and no Settings until it ends. A profile-less launch is already on its way there.
  const inSetup =
    location.pathname.startsWith("/onboarding") ||
    (profile.isSuccess && !profile.data);

  const activeSimulation = useQuery({
    queryKey: ["active-simulation"],
    queryFn: () => invoke("study.activeSimulation", {}),
    enabled: profile.isSuccess && Boolean(profile.data),
    refetchInterval: 1000,
  });
  // The menu leaves a running simulation alone, like the redirect below.
  useMenuLock(Boolean(activeSimulation.data));
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

  // Answers outside a plan use the profile's content language, which must follow the interface. Profiles saved before
  // 0.2.3 could keep "Italian" under an English interface.
  const storedLanguage = profile.data?.contentLanguage;
  const interfaceLanguage = i18n.language === "en" ? "English" : "Italian";
  useEffect(() => {
    if (!storedLanguage || storedLanguage === interfaceLanguage) return;
    void invoke("profile.save", { contentLanguage: interfaceLanguage })
      .then(() => client.invalidateQueries({ queryKey: ["profile"] }))
      .catch(() => undefined);
  }, [storedLanguage, interfaceLanguage, client]);

  return (
    <ProLayout
      layout="top"
      className={inSetup ? "px-in-setup" : undefined}
      contentWidth="Fluid"
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
      headerContentRender={inSetup ? false : () => (
        <div
          className="px-doors-wrap"
          onClick={(event) => {
            // antd fires onChange only for a new selection. A click on the active door lands here instead and goes to that door's root.
            if (!(event.target instanceof HTMLInputElement) || !activeDoor) return;
            if (
              event.target
                .closest("label")
                ?.classList.contains("ant-segmented-item-selected")
            )
              navigate(doorRoots[activeDoor]);
          }}
        >
          <Segmented<Door>
            shape="round"
            className="px-doors"
            aria-label={t("doors.label")}
            value={activeSimulation.data ? "exams" : (activeDoor ?? NO_DOOR)}
            onChange={(value) => navigate(readLast()[value])}
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
              {
                value: "maps",
                label: t("doors.maps"),
                icon: <Network size={16} strokeWidth={1.75} />,
              },
            ]}
          />
        </div>
      )}
      actionsRender={() => [
        <JobsButton key="jobs" />,
        inSetup ? null : (
          <Button
            key="settings"
            shape="circle"
            type="text"
            aria-label={t("nav.settings")}
            icon={<Settings size={18} strokeWidth={1.75} />}
            onClick={() => navigate("/settings")}
          />
        ),
      ]}
      footerRender={false}
    >
      <LaunchEngineNotice ready={profile.isSuccess && Boolean(profile.data)} />
      <PageContainer
        header={{ title: false, breadcrumb: {} }}
        className={
          target.pathname.startsWith("/settings")
            ? "px-shell-container px-shell-wide"
            : "px-shell-container"
        }
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
