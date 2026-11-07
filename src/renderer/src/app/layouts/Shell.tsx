import { Button } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate, useNavigation } from "react-router";
import { useChatActions } from "../../features/ask/chatActions";
import { JobsButton } from "../../features/jobs/JobsButton";
import { invoke } from "../../lib/ipc";
import { Finder, type FinderScope } from "../Finder";
import { LaunchEngineNotice } from "../LaunchEngineNotice";
import { useMenuLock } from "../menu-state";
import { profileQuery } from "../../lib/queries";
import { PyxisMark, Sidebar } from "./Sidebar";

export function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  // A page loads on its first visit, and the previous one stays until it has. The column and the highlighted door
  // follow the page being opened from the start, so they never depend on how long that takes.
  const target = useNavigation().location ?? location;
  const client = useQueryClient();
  const actions = useChatActions();
  const [finder, setFinder] = useState<FinderScope | null>(null);
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

  // A running exam simulation hides Chiedi, as the redirect above keeps the student out of it; so does the moment the
  // simulation check is still out.
  const simulation = activeSimulation.isLoading || Boolean(activeSimulation.data);

  // Cmd+K (Ctrl+K) searches the whole app, wherever the sidebar is.
  useEffect(() => {
    if (inSetup || simulation) return;
    const mac = window.pyxis.platform === "darwin";
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || event.shiftKey || event.altKey) return;
      if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      setFinder("all");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inSetup, simulation]);

  return (
    <div className={inSetup ? "px-app px-in-setup" : "px-app"}>
      {inSetup ? (
        // Setup is one closed flow: the mark, and the jobs its material starts, with no way out of it.
        <header className="px-setup-top">
          <span className="px-brand">
            <PyxisMark />
            Pyxis
          </span>
          <JobsButton />
        </header>
      ) : (
        <Sidebar
          pathname={target.pathname}
          simulation={simulation}
          onSearch={setFinder}
          actions={actions}
        />
      )}
      <div className="px-column">
        <div className="px-drag" aria-hidden />
        {inSetup ? null : (
          // Attività, in the top-right corner of every page, with its list opening under it.
          <div className="px-corner-tools">
            <JobsButton keep />
          </div>
        )}
      <LaunchEngineNotice ready={profile.isSuccess && Boolean(profile.data)} />
      <main
        className={
          target.pathname.startsWith("/settings")
            ? "px-shell-container px-shell-wide"
            : target.pathname.startsWith("/ask")
              ? "px-shell-container px-shell-bleed"
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
      <Finder scope={finder} onClose={() => setFinder(null)} actions={actions} />
      {actions.dialog}
    </div>
  );
}
