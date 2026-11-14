import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { goPages, pageCommands, reportProblemUrl } from "@shared/menu";
import { registeredBack, watchBack } from "./back-slot";
import { readTrail, watchTrail } from "./history";
import { menuCommandAllowed } from "./menu-guard";
import { isMenuLocked, readMenuContext, watchMenuLocks } from "./menu-state";
import { router } from "./router";
import { canForward } from "./trail";
import { checkUpdatesNow } from "../features/settings/UpdatesPanel";
import { ShortcutsDialog } from "./ShortcutsDialog";

/** Indietro runs the page's own back control; Avanti goes one entry forward. Either may be refused, as any command. */
function step(command: "back" | "forward") {
  const { pathname, key } = router.state.location;
  if (!menuCommandAllowed(command, readMenuContext(pathname))) return;
  if (command === "back") registeredBack()?.go();
  else if (canForward(readTrail(), key)) void router.navigate(1);
}

/**
 * Connects the application menu to the app: tells main which language to write it in and which of Indietro and Avanti
 * can do something now, and carries out the command a menu pick sends back, the same two that the mouse's side buttons
 * send. A command that is not allowed right now (see `menu-guard.ts`) does nothing.
 */
export function MenuCommands() {
  const { i18n } = useTranslation();
  const client = useQueryClient();
  const [shortcuts, setShortcuts] = useState(false);
  const language = i18n.language === "en" ? "en" : "it";

  useEffect(() => {
    // Without the call the menu stays in the computer's language, which is only a wrong label.
    window.pyxis.setMenuLanguage(language).catch(() => undefined);
  }, [language]);

  // The menu shows what the keys can do: Indietro where the page has a back control, Avanti where history has a page
  // ahead, and neither while a page holds a lock (a running exam simulation, the new exam being filled in, setup).
  const hasBack = useSyncExternalStore(watchBack, () => registeredBack() !== null);
  const trail = useSyncExternalStore(watchTrail, readTrail);
  const locked = useSyncExternalStore(watchMenuLocks, isMenuLocked);
  const back = hasBack && !locked;
  const forward = canForward(trail, trail.current) && !locked;
  useEffect(() => {
    // Without the call the items stay as main last had them, which only leaves a key that does nothing.
    window.pyxis.setNavState({ back, forward }).catch(() => undefined);
  }, [back, forward]);

  useEffect(
    () =>
      window.pyxis.onMenuCommand((command) => {
        const pathname = router.state.location.pathname;
        if (command === "back" || command === "forward") return step(command);
        if (!menuCommandAllowed(command, readMenuContext(pathname))) return;
        if (command === "shortcuts") return setShortcuts(true);
        if (command === "report-problem") {
          void window.pyxis
            .openExternal(reportProblemUrl)
            .catch(() => undefined);
          return;
        }
        // A section goes straight to its main page, and the page it opens has nothing behind it to go back to.
        const section = goPages.find((page) => page.command === command);
        const path =
          section?.path ??
          pageCommands[command as keyof typeof pageCommands];
        const starts = section !== undefined || command === "new-chat";
        if (path !== pathname)
          void router.navigate(path, starts ? { state: { via: "sidebar" } } : undefined);
        // The Updates page shows the check, so it starts there.
        if (command === "check-updates") void checkUpdatesNow(client);
      }),
    [client],
  );

  // The mouse's side buttons are Indietro (button 3) and Avanti (button 4) on every system. Chromium hands them to the
  // page, so the window listens here, and main's `app-command` is left alone: no button is handled twice.
  useEffect(() => {
    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      step(event.button === 3 ? "back" : "forward");
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  // A click on a study reminder: main brings the window forward and names the page. A quiz, a dialog or a text in
  // progress is not interrupted, the same rule as for a menu pick.
  useEffect(
    () =>
      window.pyxis.onOpenPath((path) => {
        const pathname = router.state.location.pathname;
        if (!menuCommandAllowed("exams", readMenuContext(pathname))) return;
        // A reminder comes from outside the app: its page goes back to its parent, not to the page under it (history.ts).
        if (path !== pathname) void router.navigate(path, { state: { via: "outside" } });
      }),
    [],
  );

  return (
    <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
  );
}
