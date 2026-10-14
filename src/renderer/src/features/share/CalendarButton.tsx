import { App, Button, Tooltip } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../lib/ipc";

/**
 * Saves upcoming exam dates as an .ics file: every exam, or just one plan's.
 * When `blocked` is set the button is off and that text says why.
 */
export function CalendarButton({
  planId,
  blocked,
  disabled = false,
}: {
  planId?: string;
  blocked?: string;
  disabled?: boolean;
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
