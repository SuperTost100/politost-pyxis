import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Skeleton } from "antd";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AutoBackupStatus } from "../../../../shared/bridge";
import { ControlGroup, ControlList, ControlRow, Reveal, SwitchRow } from "../../components/Controls";
import { Notice } from "../../components/Notice";
import { router } from "../../app/router";
import type { Locale } from "../../locales/i18n";
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

/** What a page-wide action holds the workspace for: a backup to a file, or a restore. */
export type Archiving = "backup" | "restore" | null;

/**
 * Settings > Data, "Copie di sicurezza" (pyxis-mockups app/index.html, "s-settings-data"): the daily switch and the
 * backup folder, the automatic backups that can be restored, then Back up now, a backup to a file and a restore from a
 * file. A Restore click opens its confirmation under what was clicked; the second click restores.
 */
export function BackupsGroup({
  formatSize,
  workspaceName,
  moving,
  archiving,
  setArchiving,
}: {
  formatSize: (bytes: number) => string;
  workspaceName: string;
  /** The workspace is moving: nothing else may touch it. */
  moving: boolean;
  archiving: Archiving;
  setArchiving: (value: Archiving) => void;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const { data: status } = useAutoBackups();
  // A finished backup adds a file; a new folder lists other files.
  const list = useQuery({
    queryKey: ["auto-backup-list", status?.folder, status?.lastSuccessAt],
    enabled: Boolean(status),
    queryFn: () => window.pyxis.autoBackups.list(),
  });
  const [note, setNote] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  // What the next confirming click replaces the data with: "file" asks for a file, a name is a listed backup.
  const [armed, setArmed] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const ids = { folder: useId(), list: useId() };
  const locale: Locale = i18n.language === "en" ? "en" : "it";
  const save = (next: AutoBackupStatus | null) => {
    if (next) client.setQueryData(KEY, next);
  };
  const when = (at: number) =>
    new Date(at).toLocaleString(i18n.language, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  const number = new Intl.NumberFormat(i18n.language, {
    maximumFractionDigits: 1,
  });

  /** Restores from a file the student picks, or from the listed backup `name`. */
  function restore(name?: string) {
    setArmed(null);
    setResult(null);
    setArchiving("restore");
    setRestoring(name ?? "file");
    void window.pyxis
      .restoreWorkspace(name)
      .then((outcome) => {
        if (outcome === "restored") {
          // Drafts, board strokes and staged files belong to the replaced workspace.
          sessionStorage.clear();
          window.location.reload();
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        const rolledBack = message.includes("restore-rolled-back");
        setResult(
          t(
            rolledBack
              ? "settings.restoreRolledBack"
              : message.includes("restore-recovery-required")
                ? "settings.restoreRecoveryRequired"
                : "settings.restoreFailed",
          ),
        );
        // Core ran on the restored copy for a moment; what the pages read from it is gone again.
        if (rolledBack) void client.invalidateQueries();
        // The file may be gone or no longer pass its check.
        void client.invalidateQueries({ queryKey: ["auto-backup-list"] });
      })
      .finally(() => {
        setArchiving(null);
        setRestoring(null);
      });
  }

  /** The confirmation that opens under the Restore that was clicked. */
  const confirm = (name?: string) => (
    <Reveal className="px-ctl-confirm">
      <p role="alert">{t("settings.restoreConfirm", { workspace: workspaceName })}</p>
      <div className="px-ctl-confirm-acts">
        <Button size="small" type="primary" danger onClick={() => restore(name)}>
          {t("settings.restoreReplace", { workspace: workspaceName })}
        </Button>
        <Button size="small" type="text" onClick={() => setArmed(null)}>
          {t("wizard.cancel")}
        </Button>
      </div>
    </Reveal>
  );

  const last = status?.last;
  const line = !status
    ? null
    : status.running
      ? t("settings.autoBackup.running")
      : !last
        ? t("settings.autoBackup.never")
        : last.ok
          ? t(last.verified ? "settings.autoBackup.savedVerified" : "settings.autoBackup.saved", {
              at: when(last.at),
              size: formatSize(last.size),
            })
          : t("settings.autoBackup.failed", { at: when(last.at) });
  const busy = moving || archiving !== null;
  return (
    <ControlGroup id="settings-backups" title={t("settings.backupsTitle")}>
      {status ? (
        <ControlList>
          <SwitchRow
            title={t("settings.autoBackup.switch")}
            description={t(status.enabled ? "settings.autoBackup.on" : "settings.autoBackup.off")}
            checked={status.enabled}
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
          <ControlRow id={ids.folder} title={t("settings.autoBackup.folderTitle")} description={status.folder} path>
            <div className="px-ctl-acts">
              <Button
                size="small"
                type="text"
                aria-label={t("settings.autoBackup.open")}
                onClick={() => {
                  setNote(null);
                  void window.pyxis.autoBackups
                    .openFolder()
                    .catch(() => setNote(t("settings.autoBackup.reason.folder-missing")));
                }}
              >
                {t("settings.openShort")}
              </Button>
              <Button
                size="small"
                aria-label={t("settings.autoBackup.change")}
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
                {t("settings.changeShort")}
              </Button>
            </div>
          </ControlRow>
        </ControlList>
      ) : null}
      {status && last && !last.ok && !status.running ? (
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
        <p className="px-ctl-note" role="alert">
          {note}
        </p>
      ) : null}

      {status ? (
        <>
          <p className="px-ctl-label" id={ids.list}>
            {t("settings.autoBackup.list.title")}
          </p>
          <ControlList aria-labelledby={ids.list}>
            {list.isPending ? (
              <li>
                <div className="px-ctl-row" role="status" aria-label={t("settings.autoBackup.list.loading")}>
                  <Skeleton active title={false} paragraph={{ rows: 2, width: "100%" }} />
                </div>
              </li>
            ) : list.isError ? (
              <ControlRow id={`${ids.list}-failed`} title={t("settings.autoBackup.list.failed")}>
                <Button size="small" onClick={() => void list.refetch()}>
                  {t("settings.autoBackup.list.retry")}
                </Button>
              </ControlRow>
            ) : list.data.length === 0 ? (
              <li>
                <div className="px-ctl-row">
                  <span className="px-ctl-description">{t("settings.autoBackup.list.empty")}</span>
                </div>
              </li>
            ) : (
              list.data.map((file, index) => {
                const isArmed = armed === file.name;
                const date = when(file.at);
                return (
                  <ControlRow
                    key={file.name}
                    id={`${ids.list}-${index}`}
                    title={date}
                    description={`${formatSize(file.size)} · ${t(
                      file.verified ? "settings.autoBackup.list.verified" : "settings.autoBackup.list.unverified",
                    )}`}
                    below={isArmed ? confirm(file.name) : null}
                  >
                    <Button
                      size="small"
                      type="text"
                      aria-label={t("settings.autoBackup.list.restoreOne", { at: date })}
                      aria-expanded={isArmed}
                      disabled={busy}
                      loading={restoring === file.name}
                      onClick={() => setArmed(isArmed ? null : file.name)}
                    >
                      {t("settings.autoBackup.list.restore")}
                    </Button>
                  </ControlRow>
                );
              })
            )}
          </ControlList>
          {list.data?.some((file) => !file.verified) ? (
            <p className="px-ctl-note">{t("settings.autoBackup.list.hintUnverified")}</p>
          ) : null}
        </>
      ) : null}

      <div className="px-ctl-after">
        {status ? (
          <Button
            size="small"
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
        ) : null}
        <Button
          size="small"
          type="text"
          disabled={moving || (archiving !== null && archiving !== "backup")}
          loading={archiving === "backup"}
          onClick={() => {
            // A second click while the first backup runs used to fail as "workspace busy" and say the backup failed.
            if (archiving) return;
            setArchiving("backup");
            setResult(null);
            void window.pyxis
              .backupWorkspace()
              .then((outcome) => {
                if (outcome === "saved") setResult(t("settings.backupSaved"));
              })
              .catch((error: unknown) => setResult(backupError(error, locale, t)))
              .finally(() => setArchiving(null));
          }}
        >
          {t("settings.backup")}
        </Button>
        <Button
          size="small"
          type="text"
          aria-expanded={armed === "file"}
          disabled={moving || (archiving !== null && archiving !== "restore")}
          loading={restoring === "file"}
          onClick={() => {
            if (archiving) return;
            setArmed(armed === "file" ? null : "file");
          }}
        >
          {t("settings.restore")}
        </Button>
      </div>
      {armed === "file" ? confirm() : null}
      {line ? (
        <p className="px-ctl-note" role="status">
          {line}
        </p>
      ) : null}
      {result ? (
        <p className="px-ctl-note" role="status">
          {result}
        </p>
      ) : null}
    </ControlGroup>
  );
}

/** Names the size and the limit when the workspace is too big for one backup. */
function backupError(
  error: unknown,
  locale: Locale,
  t: (key: string, params?: Record<string, string>) => string,
): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("backup-too-many-files")) return t("settings.backupTooManyFiles");
  if (message.includes("backup-destination-inside-data")) return t("settings.backupInsideData");
  const size = /backup-too-large:(\d+)/.exec(message)?.[1];
  if (!size) return t("settings.backupFailed");
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return t("settings.backupTooLarge", {
    // Rounded up, so a workspace just over the limit never reads as equal to it.
    size: number.format(Math.ceil((Number(size) / GIB) * 10) / 10),
    limit: number.format(2),
  });
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
