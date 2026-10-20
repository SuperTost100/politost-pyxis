import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Switch } from "antd";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AutoBackupStatus } from "../../../../shared/bridge";
import { Notice } from "../../components/Notice";
import { router } from "../../app/router";
import "./AutoBackups.css";

const KEY = ["auto-backups"];

/** The automatic-backup status, kept current by main's change events. */
export function useAutoBackups() {
  const client = useQueryClient();
  useEffect(
    () =>
      window.pyxis.autoBackups.onStatus((status) =>
        client.setQueryData(KEY, status),
      ),
    [client],
  );
  return useQuery({
    queryKey: KEY,
    queryFn: () => window.pyxis.autoBackups.status(),
  });
}

const GIB = 1024 ** 3;

/** Settings > Data: the switch, the folder, the last result and Back up now. */
export function AutoBackupsSection({
  formatSize,
}: {
  formatSize: (bytes: number) => string;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const { data: status } = useAutoBackups();
  const [note, setNote] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const id = useId();
  if (!status) return null;
  const save = (next: AutoBackupStatus | null) => {
    if (next) client.setQueryData(KEY, next);
  };
  const when = (at: number) =>
    new Date(at).toLocaleString(i18n.language, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  const last = status.last;
  const number = new Intl.NumberFormat(i18n.language, {
    maximumFractionDigits: 1,
  });
  const result = status.running
    ? t("settings.autoBackup.running")
    : !last
      ? t("settings.autoBackup.never")
      : last.ok
        ? t(
            last.verified
              ? "settings.autoBackup.savedVerified"
              : "settings.autoBackup.saved",
            { at: when(last.at), size: formatSize(last.size) },
          )
        : t("settings.autoBackup.failed", { at: when(last.at) });
  return (
    <div className="px-autobackup">
      <div className="px-card px-autobackup-row">
        <div className="px-autobackup-text">
          <label className="body-strong" htmlFor={id}>
            {t("settings.autoBackup.switch")}
          </label>
          <p className="small" id={`${id}-hint`}>
            {t(
              status.enabled
                ? "settings.autoBackup.on"
                : "settings.autoBackup.off",
            )}
          </p>
        </div>
        <Switch
          id={id}
          checked={status.enabled}
          aria-describedby={`${id}-hint`}
          onChange={(enabled) => {
            setNote(null);
            void window.pyxis.autoBackups
              .setEnabled(enabled)
              .then(save)
              .catch(() => {
                setNote(t("settings.saveFailed"));
                // The switch shows the saved setting again, not the one that failed.
                void client.invalidateQueries({ queryKey: KEY });
              });
          }}
        />
      </div>
      <p className="small px-autobackup-path">
        {t("settings.autoBackup.folder", { path: status.folder })}
      </p>
      <div className="px-settings-actions">
        <Button
          loading={status.running}
          disabled={status.running}
          onClick={() => {
            setNote(null);
            void window.pyxis.autoBackups
              .runNow()
              .then(save)
              .catch(() => setNote(t("settings.backupFailed")));
          }}
        >
          {t("settings.autoBackup.now")}
        </Button>
        <Button
          loading={choosing}
          disabled={status.running}
          onClick={() => {
            setNote(null);
            setChoosing(true);
            void window.pyxis.autoBackups
              .chooseFolder()
              .then(save)
              .catch((error: unknown) => {
                const message = error instanceof Error ? error.message : "";
                setNote(
                  t(
                    message.includes("backup-folder-inside-data")
                      ? "settings.autoBackup.reason.folder-inside-data"
                      : message.includes("backup-folder-permission")
                        ? "settings.autoBackup.reason.permission"
                        : "settings.autoBackup.reason.folder-missing",
                  ),
                );
              })
              .finally(() => setChoosing(false));
          }}
        >
          {t("settings.autoBackup.change")}
        </Button>
        <Button
          type="text"
          onClick={() => {
            setNote(null);
            void window.pyxis.autoBackups
              .openFolder()
              .catch(() =>
                setNote(t("settings.autoBackup.reason.folder-missing")),
              );
          }}
        >
          {t("settings.autoBackup.open")}
        </Button>
      </div>
      <p className="small section-hint" role="status">
        {result}
      </p>
      {last && !last.ok && !status.running ? (
        <Notice tone="warning">
          {t(`settings.autoBackup.reason.${last.reason}`, {
            size: number.format(Math.ceil(((last.size ?? 0) / GIB) * 10) / 10),
            limit: number.format(2),
          })}
          {status.lastSuccessAt
            ? ` ${t("settings.autoBackup.lastGood", { at: when(status.lastSuccessAt) })}`
            : ""}
        </Notice>
      ) : null}
      {note ? (
        <p className="small section-hint" role="alert">
          {note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Shown over every page when an automatic backup failed, so a skipped backup is never silent. It names the cause, and
 * Settings > Data has the fixes (another folder, or turning backups off).
 */
export function BackupNotice() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const client = useQueryClient();
  const { data } = useAutoBackups();
  if (!data?.notice) return null;
  return (
    <aside
      className="px-update-notice px-backup-notice"
      aria-label={t("settings.autoBackup.title")}
    >
      <Notice tone="warning">
        {t("settings.autoBackup.notice", {
          reason: t(`settings.autoBackup.short.${data.notice}`),
        })}
      </Notice>
      <div className="px-backup-notice-actions">
        <Button
          type="text"
          size="small"
          onClick={() => void router.navigate("/settings/data")}
        >
          {t("settings.autoBackup.fix")}
        </Button>
        <Button
          type="text"
          size="small"
          onClick={() =>
            void window.pyxis.autoBackups
              .dismissNotice()
              .then((status) => client.setQueryData(KEY, status))
              .catch(() => {
                void message.error(t("settings.autoBackup.dismissFailed"));
                void client.invalidateQueries({ queryKey: KEY });
              })
          }
        >
          {t("updates.dismiss")}
        </Button>
      </div>
    </aside>
  );
}
