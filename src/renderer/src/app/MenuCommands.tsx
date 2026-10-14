import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { goPages, pageCommands, reportProblemUrl } from "@shared/menu";
import { menuCommandAllowed } from "./menu-guard";
import { readMenuContext } from "./menu-state";
import { router } from "./router";
import { doorTarget } from "./layouts/Shell";
import { ShortcutsDialog } from "./ShortcutsDialog";

/**
 * Connects the application menu to the app: tells main which language to write it in, and carries out the command a
 * menu pick sends back. A command that is not allowed right now (see `menu-guard.ts`) does nothing.
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

  useEffect(
    () =>
      window.pyxis.onMenuCommand((command) => {
        const pathname = router.state.location.pathname;
        if (!menuCommandAllowed(command, readMenuContext(pathname))) return;
        if (command === "shortcuts") return setShortcuts(true);
        if (command === "report-problem") {
          void window.pyxis
            .openExternal(reportProblemUrl)
            .catch(() => undefined);
          return;
        }
        if (command === "back") {
          void router.navigate(-1);
          return;
        }
        // Ask and Exams are the two doors in the header, so they return to where that door was left.
        const path =
          command === "ask" || command === "exams"
            ? doorTarget(command, pathname)
            : (goPages.find((page) => page.command === command)?.path ??
              pageCommands[command as keyof typeof pageCommands]);
        if (path !== pathname) void router.navigate(path);
        // The Updates page shows the check, so it starts there.
        if (command === "check-updates")
          void client.refetchQueries({ queryKey: ["updates"] });
      }),
    [client],
  );

  return (
    <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
  );
}
