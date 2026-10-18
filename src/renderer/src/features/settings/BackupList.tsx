import { useQuery } from "@tanstack/react-query";
import { Button, Skeleton } from "antd";
import { useTranslation } from "react-i18next";
import { useAutoBackups } from "./AutoBackups";
import "./AutoBackups.css";

/**
 * Settings > Data: the automatic backups in the folder that did not fail their check, each with Restore. A copy the check could not reach is marked. A click arms the row
 * (the same confirmation as restoring from a file); the second click restores. The restore itself runs in the page,
 * which owns the busy state shared with Back up and Move.
 */
export function BackupList({
  formatSize,
  workspaceName,
  armed,
  restoring,
  disabled,
  onArm,
  onRestore,
}: {
  formatSize: (bytes: number) => string;
  workspaceName: string;
  /** The backup waiting for its confirming click. */
  armed: string | null;
  /** The backup being restored now. */
  restoring: string | null;
  /** Something else holds the workspace: a backup, a restore from a file, a move. */
  disabled: boolean;
  onArm: (name: string | null) => void;
  onRestore: (name: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { data: status } = useAutoBackups();
  // A finished backup adds a file; a new folder lists other files.
  const list = useQuery({
    queryKey: ["auto-backup-list", status?.folder, status?.lastSuccessAt],
    enabled: Boolean(status),
    queryFn: () => window.pyxis.autoBackups.list(),
  });
  if (!status) return null;
  const when = (at: number) =>
    new Date(at).toLocaleString(i18n.language, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  return (
    <section className="px-backup-list" aria-labelledby="px-backup-list-title">
      <div className="label section-label" id="px-backup-list-title">
        {t("settings.autoBackup.list.title")}
      </div>
      {list.isPending ? (
        <div role="status" aria-label={t("settings.autoBackup.list.loading")}>
          <Skeleton active title={false} paragraph={{ rows: 2, width: "100%" }} />
        </div>
      ) : list.isError ? (
        <div className="px-backup-list-empty">
          <p className="small ink-muted">{t("settings.autoBackup.list.failed")}</p>
          <Button onClick={() => void list.refetch()}>
            {t("settings.autoBackup.list.retry")}
          </Button>
        </div>
      ) : list.data.length === 0 ? (
        <p className="small ink-muted px-backup-list-empty">
          {t("settings.autoBackup.list.empty")}
        </p>
      ) : (
        <>
          <p className="small section-hint">
            {t("settings.autoBackup.list.hint")}
            {list.data.some((file) => !file.verified)
              ? ` ${t("settings.autoBackup.list.hintUnverified")}`
              : ""}
          </p>
          <ul className="px-backup-items">
            {list.data.map((file) => {
              const isArmed = armed === file.name;
              const date = when(file.at);
              return (
                <li className="px-card px-backup-item" key={file.name}>
                  <span className="px-backup-item-text">
                    <span className="body-strong">{date}</span>
                    <span className="small ink-muted">
                      {formatSize(file.size)}
                      {file.verified
                        ? ""
                        : ` · ${t("settings.autoBackup.list.unverified")}`}
                    </span>
                  </span>
                  <span className="px-backup-item-actions">
                    <Button
                      danger={isArmed}
                      disabled={disabled}
                      loading={restoring === file.name}
                      aria-label={
                        isArmed
                          ? undefined
                          : t("settings.autoBackup.list.restoreOne", { at: date })
                      }
                      onClick={() =>
                        isArmed ? onRestore(file.name) : onArm(file.name)
                      }
                    >
                      {isArmed
                        ? t("settings.restoreReplace", { workspace: workspaceName })
                        : t("settings.autoBackup.list.restore")}
                    </Button>
                    {isArmed ? (
                      <Button type="text" onClick={() => onArm(null)}>
                        {t("wizard.cancel")}
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
          {armed ? (
            <p className="small section-hint" role="alert">
              {t("settings.restoreConfirm", { workspace: workspaceName })}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
