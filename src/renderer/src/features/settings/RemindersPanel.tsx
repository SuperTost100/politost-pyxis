import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isReminderTime } from "@shared/reminder";
import { ControlList, SwitchRow } from "../../components/Controls";
import { Notice } from "../../components/Notice";
import "./AutoBackups.css";

const KEY = ["reminders"];

/** The study reminder settings, shared by the panel and the settings list. */
export function useReminders() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => window.pyxis.reminders.get(),
  });
}

/** Settings > Study reminders: the switch (off by default) and the time of day. */
export function RemindersPanel() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { data } = useReminders();
  const [failed, setFailed] = useState(false);
  if (!data) return null;
  const save = (next: { enabled: boolean; time: string }) => {
    setFailed(false);
    void window.pyxis.reminders
      .set(next)
      .then((saved) => client.setQueryData(KEY, saved))
      .catch(() => {
        setFailed(true);
        // The controls show the saved setting again, not the one that failed.
        void client.invalidateQueries({ queryKey: KEY });
      });
  };
  return (
    <div className="px-autobackup">
      <ControlList>
        <SwitchRow
          title={t("settings.reminders.switch")}
          description={t(data.enabled ? "settings.reminders.on" : "settings.reminders.off")}
          checked={data.enabled}
          onChange={(enabled) => save({ enabled, time: data.time })}
        >
          {data.enabled ? (
            <input
              // The field holds what is typed until the time is complete; a clock that is cleared keeps the saved one.
              key={data.time}
              className="px-reminder-time"
              type="time"
              aria-label={t("settings.reminders.time")}
              defaultValue={data.time}
              onBlur={(event) => {
                const time = event.target.value;
                if (isReminderTime(time) && time !== data.time) save({ enabled: true, time });
                else event.target.value = data.time;
              }}
            />
          ) : null}
        </SwitchRow>
      </ControlList>
      {data.enabled ? <p className="small section-hint">{t("settings.reminders.quiet")}</p> : null}
      {!data.supported ? (
        <Notice tone="warning">{t("settings.reminders.unsupported")}</Notice>
      ) : null}
      {failed ? (
        <p className="small section-hint" role="alert">
          {t("settings.saveFailed")}
        </p>
      ) : null}
    </div>
  );
}
