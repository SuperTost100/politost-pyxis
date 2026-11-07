import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Checkbox } from "antd";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "@shared/format-bytes";
import { ControlGroup, ControlList, ControlRow, Reveal } from "../../components/Controls";
import { CrashReportsSwitch } from "../../components/CrashReportsSwitch";
import { OcrDataRow } from "../../components/OcrData";
import { invoke } from "../../lib/ipc";
import { BackupsGroup, useAutoBackups, type Archiving } from "./AutoBackups";

/**
 * Settings > Data and privacy (pyxis-mockups app/index.html, "s-settings-data"): where the data is, the backups, the
 * crash reports and deleting everything. Moving the workspace, a backup and a restore each hold it, so the page keeps
 * those states and every button that would touch the workspace meanwhile waits.
 */
export function DataPanel({
  crashReports,
  onCrashReports,
}: {
  crashReports: boolean;
  onCrashReports: (value: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const { modal } = App.useApp();
  const ids = { folder: useId(), space: useId(), wipe: useId() };
  const [moving, setMoving] = useState(false);
  const [archiving, setArchiving] = useState<Archiving>(null);
  const [freeing, setFreeing] = useState(false);
  const [freeNote, setFreeNote] = useState<string | null>(null);
  const [whereNote, setWhereNote] = useState<string | null>(null);
  const [wipeArmed, setWipeArmed] = useState(false);
  const [wipeBackups, setWipeBackups] = useState(true);
  // From the confirming click until main answers: a second click would start another wipe.
  const [wiping, setWiping] = useState(false);
  const [wipeNote, setWipeNote] = useState<string | null>(null);
  const place = useQuery({
    queryKey: ["workspace-path"],
    queryFn: () => window.pyxis.workspacePath(),
  });
  // The same query as the backups group, which keeps it current.
  const backupFolder = useAutoBackups().data?.folder;
  const usage = useQuery({
    queryKey: ["plan-usage"],
    queryFn: () => invoke("plans.usage", {}),
  });
  const size = (bytes: number) => formatBytes(bytes, i18n.language);
  const workspaceName = place.data?.split(/[\\/]/).filter(Boolean).at(-1) ?? t("settings.workspaceThis");

  async function move() {
    setWhereNote(null);
    setMoving(true);
    try {
      const result = await window.pyxis.moveWorkspace();
      if (result.status === "moved") {
        client.setQueryData(["workspace-path"], result.path);
        void client.invalidateQueries({ queryKey: ["plan-usage"] });
        void client.invalidateQueries({ queryKey: ["jobs"] });
        setWhereNote(
          t(result.cleanupPending ? "settings.moveCleanup" : "settings.moveSaved", { path: place.data ?? "" }),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const key = message.includes("workspace-move-destination-exists")
        ? "settings.moveExists"
        : message.includes("workspace-move-path-overlap")
          ? "settings.moveOverlap"
          : message.includes("workspace-move-symlink")
            ? "settings.moveSymlink"
            : message.includes("workspace-move-recovery-unavailable")
              ? "settings.moveRecovery"
              : "settings.moveFailed";
      setWhereNote(t(key));
    } finally {
      setMoving(false);
    }
  }

  function freeSpace() {
    if (freeing) return;
    setFreeing(true);
    setFreeNote(null);
    void invoke("plans.freeSpace", {})
      .then(({ bytes }) => {
        void client.invalidateQueries({ queryKey: ["plan-usage"] });
        setFreeNote(bytes > 0 ? t("settings.freeSpaceDone", { size: size(bytes) }) : t("settings.freeSpaceNothing"));
      })
      .catch(() => setFreeNote(t("settings.freeSpaceFailed")))
      .finally(() => setFreeing(false));
  }

  function wipe() {
    if (wiping) return;
    setWipeNote(null);
    setWiping(true);
    void window.pyxis
      .wipeWorkspace({ backups: wipeBackups })
      .then((result) => {
        // The reload keeps sessionStorage, so clear drafts, board data and last paths of the deleted workspace first.
        sessionStorage.clear();
        if (result === "wiped") {
          window.location.reload();
          return;
        }
        // The reload lands on setup, so say what was left before it.
        modal.warning({
          title: t("settings.wipeBackupsLeftTitle"),
          content: t("settings.wipeBackupsLeft", { folder: backupFolder ?? "" }),
          afterClose: () => window.location.reload(),
        });
      })
      .catch((error: unknown) => {
        setWiping(false);
        setWipeArmed(false);
        // Main tags the failure that came after the engine keys were cleared. Any other failure left them in place.
        setWipeNote(
          t(
            error instanceof Error && error.message.includes("wipe-after-keys")
              ? "settings.wipeKeysCleared"
              : "settings.wipeFailed",
          ),
        );
      });
  }

  return (
    <div className="px-settings-groups">
      <ControlGroup title={t("settings.where.title")}>
        <ControlList>
          <ControlRow id={ids.folder} title={t("settings.where.folder")} description={place.data ?? ""} path>
            <div className="px-ctl-acts">
              <Button
                size="small"
                type="text"
                aria-label={t("settings.where.open")}
                onClick={() => {
                  setWhereNote(null);
                  void window.pyxis.openWorkspace().catch(() => setWhereNote(t("settings.where.openFailed")));
                }}
              >
                {t("settings.openShort")}
              </Button>
              <Button
                size="small"
                aria-label={t("settings.move")}
                loading={moving}
                disabled={moving || archiving !== null}
                onClick={() => void move()}
              >
                {t("settings.moveShort")}
              </Button>
            </div>
          </ControlRow>
          <ControlRow
            id={ids.space}
            title={
              usage.data
                ? t("settings.where.examsSize", { size: size(usage.data.reduce((sum, plan) => sum + plan.bytes, 0)) })
                : t("settings.where.examsSizeLoading")
            }
            description={<span role="status">{freeNote ?? t("settings.freeSpaceHint")}</span>}
          >
            <Button size="small" loading={freeing} disabled={moving || archiving !== null} onClick={freeSpace}>
              {t("settings.freeSpace")}
            </Button>
          </ControlRow>
          <OcrDataRow />
        </ControlList>
        {whereNote ? (
          <p className="px-ctl-note" role="status">
            {whereNote}
          </p>
        ) : null}
      </ControlGroup>

      <BackupsGroup
        formatSize={size}
        workspaceName={workspaceName}
        moving={moving}
        archiving={archiving}
        setArchiving={setArchiving}
      />

      <ControlGroup id="settings-privacy" title={t("settings.privacy")}>
        <CrashReportsSwitch checked={crashReports} onChange={onCrashReports} />
      </ControlGroup>

      <ControlGroup id="settings-wipe">
        <ControlList className="px-ctl px-settings-danger">
          <ControlRow
            id={ids.wipe}
            title={t("settings.wipe")}
            description={t("settings.wipeLine")}
            below={
              wipeArmed ? (
                <Reveal className="px-ctl-confirm">
                  <Checkbox
                    checked={wipeBackups}
                    disabled={wiping}
                    onChange={(event) => setWipeBackups(event.target.checked)}
                  >
                    {t("settings.wipeBackups")}
                  </Checkbox>
                  <p role="alert">
                    {wipeBackups
                      ? backupFolder
                        ? t("settings.wipeBackupsFolder", { folder: backupFolder })
                        : null
                      : t("settings.wipeConfirmHint")}
                  </p>
                  <p>{t("settings.wipeKeys")}</p>
                  <div className="px-ctl-confirm-acts">
                    <Button
                      size="small"
                      type="primary"
                      danger
                      loading={wiping}
                      disabled={moving || wiping || archiving !== null}
                      onClick={wipe}
                    >
                      {t("settings.wipeConfirm")}
                    </Button>
                    <Button size="small" type="text" disabled={wiping} onClick={() => setWipeArmed(false)}>
                      {t("wizard.cancel")}
                    </Button>
                  </div>
                </Reveal>
              ) : null
            }
          >
            <Button
              size="small"
              className="px-ctl-danger"
              aria-label={t("settings.wipe")}
              aria-expanded={wipeArmed}
              disabled={moving || wiping || archiving !== null}
              onClick={() => {
                if (!wipeArmed) setWipeBackups(true);
                setWipeArmed(!wipeArmed);
              }}
            >
              {t("settings.wipeShort")}
            </Button>
          </ControlRow>
        </ControlList>
        {wipeNote ? (
          <p className="px-ctl-note" role="status">
            {wipeNote}
          </p>
        ) : null}
      </ControlGroup>
    </div>
  );
}
