import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input, Switch } from "antd";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { isReminderTime } from "@shared/reminder";
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
  const id = useId();
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
      <div className="px-card px-autobackup-row">
        <div className="px-autobackup-text">
          <label className="body-strong" htmlFor={id}>
            {t("settings.reminders.switch")}
          </label>
          <p className="small" id={`${id}-hint`}>
            {t(data.enabled ? "settings.reminders.on" : "settings.reminders.off")}
          </p>
        </div>
        <Switch
          id={id}
          checked={data.enabled}
          aria-describedby={`${id}-hint`}
          onChange={(enabled) => save({ enabled, time: data.time })}
        />
      </div>
      {data.enabled ? (
        <>
          <label className="px-reminder-time">
            <span className="label">{t("settings.reminders.time")}</span>
            <Input
              // The field holds what is typed until the time is complete; a clock that is cleared keeps the saved one.
              key={data.time}
              type="time"
              defaultValue={data.time}
              onBlur={(event) => {
                const time = event.target.value;
                if (isReminderTime(time) && time !== data.time)
                  save({ enabled: true, time });
                else event.target.value = data.time;
              }}
            />
          </label>
          <p className="small section-hint">{t("settings.reminders.quiet")}</p>
        </>
      ) : null}
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
