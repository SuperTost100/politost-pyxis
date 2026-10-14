import { App, Button, Tooltip } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../lib/ipc";
import { IconButton } from "../../components/IconButton";

/**
 * Saves one plan's exam date as an .ics file. When `blocked` is set the button
 * is off and that text says why. `icon` draws the round icon-only button the
 * plan header uses next to its settings button.
 */
export function CalendarButton({
  planId,
  blocked,
  disabled = false,
  icon = false,
}: {
  planId: string;
  blocked?: string;
  disabled?: boolean;
  icon?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const file = await invoke("plans.calendar", {
        planId,
        language: i18n.language.startsWith("it") ? "it" : "en",
      });
      // A date can pass between the page loading and the click.
      if (file.count === 0) {
        void message.info(t("calendar.nothing"));
        return;
      }
      const result = await window.pyxis.saveArtifact({
        filename: file.filename,
        base64: file.base64,
      });
      if (result === "saved") void message.success(t("calendar.saved"));
    } catch {
      void message.error(t("calendar.failed"));
    } finally {
      setBusy(false);
    }
  }

  if (icon)
    return (
      <IconButton
        icon="calendar-plus"
        label={t("calendar.add")}
        disabled={disabled || busy || Boolean(blocked)}
        onClick={() => void save()}
      />
    );
  const button = (
    <Button
      shape="round"
      loading={busy}
      disabled={disabled || Boolean(blocked)}
      onClick={() => void save()}
    >
      {t("calendar.add")}
    </Button>
  );
  return blocked ? (
    <Tooltip title={blocked}>
      <span>{button}</span>
    </Tooltip>
  ) : (
    button
  );
}
