import { Button } from "antd";
import { BookOpen, Settings } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation, useNavigate, useNavigation } from "react-router";
import { JobsButton } from "../../features/jobs/JobsButton";
import { invoke } from "../../lib/ipc";
import { LaunchEngineNotice } from "../LaunchEngineNotice";
import { useMenuLock } from "../menu-state";
import { profileQuery } from "../../lib/queries";

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


export function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  // A page loads on its first visit, and the previous one stays until it has. The column and the highlighted door
  // follow the page being opened from the start, so they never depend on how long that takes.
  const target = useNavigation().location ?? location;
  const client = useQueryClient();
  const activeDoor = doorForPath(target.pathname);
  const profile = useQuery({ ...profileQuery, retry: 10, retryDelay: 300 });

  // Setup is a closed flow: no section and no Settings until it ends. A profile-less launch is already on its way there.
  const inSetup =
    location.pathname.startsWith("/onboarding") ||
    (profile.isSuccess && !profile.data);

  const activeSimulation = useQuery({
    queryKey: ["active-simulation"],
    queryFn: () => invoke("study.activeSimulation", {}),
    enabled: profile.isSuccess && Boolean(profile.data),
    // No polling: the exam page invalidates this when an exam starts, runs out of time or is handed in.
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

  // A running exam simulation hides Ask and keeps Exams current, as the redirect above keeps the student there.
  const doors: Door[] = activeSimulation.data ? ["exams", "maps"] : ["ask", "exams", "maps"];
  const currentDoor = activeSimulation.data ? "exams" : activeDoor;

  return (
    <div className={inSetup ? "px-app px-in-setup" : "px-app"}>
      <header className="px-top">
        {/* The brand opens Home, a new chat, as in the mockup. Setup and a running simulation keep it plain, since
            neither may be left from here. */}
        {inSetup || activeSimulation.data ? (
          <span className="px-brand">
            <PyxisMark />
            Pyxis
          </span>
        ) : (
          <Link className="px-brand" to="/ask">
            <PyxisMark />
            Pyxis
          </Link>
        )}
        {inSetup ? null : (
          <nav className="px-nav" aria-label={t("doors.label")}>
            {doors.map((door) => (
              <Link
                key={door}
                to={doorTarget(door, target.pathname)}
                // During a simulation Exams stays highlighted, but only the open section is the current page.
                aria-current={activeDoor === door ? "page" : undefined}
                data-selected={currentDoor === door ? "" : undefined}
              >
                {t(`doors.${door}`)}
              </Link>
            ))}
          </nav>
        )}
        <div className="px-top-tools">
          {inSetup ? null : (
            <Link
              to="/exams/library"
              className="px-top-tool"
              aria-label={t("nav.library")}
              title={t("nav.library")}
              aria-current={target.pathname.startsWith("/exams/library") ? "page" : undefined}
            >
              <BookOpen size={18} strokeWidth={1.75} aria-hidden />
            </Link>
          )}
          <JobsButton />
          {inSetup ? null : (
            <Link
              to="/settings"
              className="px-top-tool"
              aria-label={t("nav.settings")}
              title={t("nav.settings")}
              aria-current={target.pathname.startsWith("/settings") ? "page" : undefined}
            >
              <Settings size={18} strokeWidth={1.75} aria-hidden />
            </Link>
          )}
        </div>
      </header>
      <LaunchEngineNotice ready={profile.isSuccess && Boolean(profile.data)} />
      <main
        className={
          target.pathname.startsWith("/settings")
            ? "px-shell-container px-shell-wide"
            : "px-shell-container"
        }
      >
        <div className="shell-page">
          {activeSimulation.data ? (
            <Button
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
      </main>
    </div>
  );
}

/** The Pyxis mark: three star trails and the star, in the text colour (pyxis-mockups app/index.html, #pyxis-mark). */
function PyxisMark() {
  return (
    <svg className="px-brand-mark" viewBox="6 10 88 88" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="6.5" strokeLinecap="round">
        <path d="M34.96,48.53 A16,16 0 1 1 55.47,69.04" />
        <path d="M25.75,68.00 A28,28 0 1 1 77.57,49.14" opacity=".75" />
        <path d="M24.29,23.36 A40,40 0 0 1 80.64,79.71" opacity=".55" />
      </g>
      <path
        fill="currentColor"
        d="M50,45 C51.62,52.38 51.62,52.38 59,54 C51.62,55.62 51.62,55.62 50,63 C48.38,55.62 48.38,55.62 41,54 C48.38,52.38 48.38,52.38 50,45Z"
      />
    </svg>
  );
}
