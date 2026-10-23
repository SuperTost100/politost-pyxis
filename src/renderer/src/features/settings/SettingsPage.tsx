import { AboutPanel } from "./AboutPanel";
import { UpdatesPanel } from "./UpdatesPanel";
import { AutoBackupsSection } from "./AutoBackups";
import { BackupList } from "./BackupList";
import { RemindersPanel, useReminders } from "./RemindersPanel";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Checkbox, Input, InputNumber } from "antd";
import {
  ArrowLeft,
  ChevronRight,
  UserRound,
  Brain,
  Cpu,
  Palette,
  Languages,
  HardDrive,
  Shield,
  RefreshCw,
  Info,
  ALargeSmall,
  Bell,
  Terminal,
  Layers,
} from "lucide-react";
import { CrashReportsSwitch } from "../../components/CrashReportsSwitch";
import { Notice } from "../../components/Notice";
import { OcrDataCard } from "../../components/OcrData";
import "./SettingsPage.css";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useAppState } from "../../app/app-state";
import { PROFILE_LIMITS } from "@shared/limits";
import { invoke } from "../../lib/ipc";
import { i18n, setLanguage, type Locale } from "../../locales/i18n";
import { EnginesPanel } from "./EnginesPanel";
import { formatBytes } from "@shared/format-bytes";
import { useProfile } from "../../lib/queries";

const levels = [
  "primary",
  "lower-secondary",
  "upper-secondary",
  "technical",
  "vocational",
  "university",
  "other",
] as const;

/** From this window width the sections sit in a sidebar; below it each one is a page of its own. */
const TWO_PANE = "(min-width: 960px)";

function useTwoPane(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(TWO_PANE);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia(TWO_PANE).matches,
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const { appearance, setTheme } = useAppState();
  const locale: Locale = i18n.language === "en" ? "en" : "it";
  const [params] = useSearchParams();
  const route = useParams<{ section: string }>();
  const section =
    route.section ??
    params.get("section") ??
    (params.get("setup") === "1" ? "engines" : null);
  const navigate = useNavigate();
  const twoPane = useTwoPane();
  const client = useQueryClient();
  const profile = useProfile();

  const cardSettings = useQuery({
    queryKey: ["card-settings"],
    queryFn: () => invoke("study.cardSettings", {}),
  });
  const [draftNewPerDay, setDraftNewPerDay] = useState<number | null>(null);
  async function saveNewPerDay() {
    const value = draftNewPerDay;
    setDraftNewPerDay(null);
    if (value == null || value === cardSettings.data?.newPerDay) return;
    setSaveError(false);
    try {
      client.setQueryData(
        ["card-settings"],
        await invoke("study.saveCardSettings", { newPerDay: value }),
      );
      // Due counts on the path and in card sessions follow the new limit.
      await Promise.all(
        ["plan", "plans", "card-queue", "cards"].map((key) =>
          client.invalidateQueries({ queryKey: [key] }),
        ),
      );
    } catch {
      setSaveError(true);
    }
  }

  const [saveError, setSaveError] = useState(false);
  const [draftInterests, setDraftInterests] = useState<string | null>(null);
  const [dataNote, setDataNote] = useState<string | null>(null);
  const [wipeArmed, setWipeArmed] = useState(false);
  const [wipeBackups, setWipeBackups] = useState(true);
  // From the confirming click until main answers: a second click would start another wipe.
  const [wiping, setWiping] = useState(false);
  const { modal } = App.useApp();
  // What the next click on a Restore button replaces the data with: "file" asks for a file, a name is a listed backup.
  const [restoreArmed, setRestoreArmed] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [archiving, setArchiving] = useState<"backup" | "restore" | null>(null);
  const [freeing, setFreeing] = useState(false);
  const [freeNote, setFreeNote] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const place = useQuery({
    queryKey: ["workspace-path"],
    queryFn: () => window.pyxis.workspacePath(),
  });
  // The same query as the automatic backups section, which keeps it current.
  const backupStatus = useQuery({
    queryKey: ["auto-backups"],
    queryFn: () => window.pyxis.autoBackups.status(),
  });
  const backupFolder = backupStatus.data?.folder;
  const reminders = useReminders();
  const usage = useQuery({
    queryKey: ["plan-usage"],
    queryFn: () => invoke("plans.usage", {}),
  });

  async function patch(input: {
    displayName?: string;
    educationLevel?: (typeof levels)[number];
    year?: string;
    followups?: boolean;
    school?: string;
    course?: string;
    dyslexia?: boolean;
    textSize?: "sm" | "md" | "lg";
    tutorMode?: "solver" | "socratic";
    interests?: string[];
    interestsOn?: boolean;
    crashReports?: boolean;
  }) {
    setSaveError(false);
    try {
      const saved = await invoke("profile.save", input);
      client.setQueryData(["profile"], saved);
      document.documentElement.dataset.dyslexia = saved.dyslexia ? "on" : "off";
      document.documentElement.dataset.text = saved.textSize;
    } catch {
      setSaveError(true);
    }
  }
  /** Restores from a file the student picks, or from the listed backup `name`. */
  function restore(name?: string) {
    setRestoreArmed(null);
    setDataNote(null);
    setArchiving("restore");
    setRestoring(name ?? "file");
    void window.pyxis
      .restoreWorkspace(name)
      .then((status) => {
        if (status === "restored") {
          // Drafts, board strokes and staged files belong to the replaced workspace.
          sessionStorage.clear();
          window.location.reload();
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        const rolledBack = message.includes("restore-rolled-back");
        setDataNote(
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
  const workspaceName =
    place.data?.split(/[\\/]/).filter(Boolean).at(-1) ??
    t("settings.workspaceThis");
  const labels: Record<string, string> = {
    profile: t("settings.profile"),
    engines: t("settings.enginesTitle"),
    tutor: t("settings.tutor"),
    reading: t("settings.reading"),
    flashcards: t("settings.flashcards"),
    reminders: t("settings.reminders.title"),
    appearance: t("settings.appearance"),
    language: t("settings.language"),
    data: t("settings.data"),
    privacy: t("settings.privacy"),
    updates: t("updates.title"),
    about: t("settings.about"),
    diagnostics: t("settings.diagnostics"),
  };
  const levelChoices = (
    <>
      <div className="label section-label">{t("settings.level")}</div>
      <div className="choice-list px-profile-levels">
        {levels.map((item) => (
          <Choice
            key={item}
            label={t(`onboarding.levels.${item}`)}
            selected={(profile.data?.educationLevel ?? "university") === item}
            onClick={() => void patch({ educationLevel: item })}
          />
        ))}
      </div>
    </>
  );
  // Two groups: how you study, and the app itself. A group of one row only repeats its row.
  const groups = [
    {
      name: t("settings.groups.study"),
      rows: [
        {
          key: "profile",
          icon: UserRound,
          value: profile.data?.displayName ?? "",
        },
        { key: "engines", icon: Cpu, value: "" },
        {
          key: "tutor",
          icon: Brain,
          value: t(
            profile.data?.tutorMode === "socratic"
              ? "settings.socratic"
              : "settings.solver",
          ),
        },
        {
          key: "reading",
          icon: ALargeSmall,
          value: t(`settings.text.${profile.data?.textSize ?? "md"}`),
        },
        {
          key: "flashcards",
          icon: Layers,
          value: cardSettings.data ? String(cardSettings.data.newPerDay) : "",
        },
        {
          key: "reminders",
          icon: Bell,
          value: reminders.data?.enabled
            ? reminders.data.time
            : t("settings.reminders.valueOff"),
        },
      ],
    },
    {
      name: t("settings.groups.app"),
      rows: [
        {
          key: "appearance",
          icon: Palette,
          value: t(`settings.${appearance.source}`),
        },
        {
          key: "language",
          icon: Languages,
          value: t(locale === "it" ? "settings.italian" : "settings.english"),
        },
        { key: "data", icon: HardDrive, value: "" },
        { key: "privacy", icon: Shield, value: "" },
        { key: "updates", icon: RefreshCw, value: "" },
        { key: "about", icon: Info, value: "" },
        { key: "diagnostics", icon: Terminal, value: "" },
      ],
    },
  ];
  const panels: Record<string, ReactNode> = {
    appearance: (
      <>
        <div className="choice-list">
          <Choice
            label={t("settings.system")}
            selected={appearance.source === "system"}
            onClick={() => void setTheme("system")}
          />
          <Choice
            label={t("settings.dark")}
            selected={appearance.source === "dark"}
            onClick={() => void setTheme("dark")}
          />
          <Choice
            label={t("settings.light")}
            selected={appearance.source === "light"}
            onClick={() => void setTheme("light")}
          />
        </div>
        {appearance.source === "system" ? (
          <p className="small section-hint">{t("settings.themeHint")}</p>
        ) : null}
      </>
    ),
    engines: <EnginesPanel />,
    tutor: (
      <>
        <div className="choice-list">
          <Choice
            label={t("settings.solver")}
            selected={(profile.data?.tutorMode ?? "solver") === "solver"}
            onClick={() => void patch({ tutorMode: "solver" })}
          />
          <Choice
            label={t("settings.socratic")}
            selected={profile.data?.tutorMode === "socratic"}
            onClick={() => void patch({ tutorMode: "socratic" })}
          />
        </div>
        <div className="choice-list">
          <Choice
            label={t("settings.followups")}
            selected={profile.data?.followups !== false}
            onClick={() =>
              void patch({ followups: profile.data?.followups === false })
            }
          />
        </div>
        {levelChoices}
      </>
    ),
    profile: (
      <>
        <div className="px-settings-profile-fields">
          {(["displayName", "year", "school", "course"] as const).map((field) => (
            <label className="px-form-field" key={field}>
              <span className="label">
                {t(
                  field === "displayName"
                    ? "onboarding.name"
                    : `onboarding.${field}`,
                )}
              </span>
              <Input
                key={profile.data?.[field] ?? ""}
                maxLength={PROFILE_LIMITS[field]}
                placeholder={t(`settings.fieldPlaceholder.${field}`)}
                defaultValue={profile.data?.[field] ?? ""}
                onBlur={(event) =>
                  void patch({ [field]: event.target.value.trim() })
                }
              />
            </label>
          ))}
        </div>
        {levelChoices}
        <div className="label section-label">{t("settings.interests")}</div>
        <div className="choice-list">
          <Choice
            label={t("settings.interestsOn")}
            selected={profile.data?.interestsOn !== false}
            onClick={() =>
              void patch({ interestsOn: profile.data?.interestsOn === false })
            }
          />
        </div>
        <Input
          className="px-settings-interests"
          aria-label={t("settings.interests")}
          placeholder={t("settings.fieldPlaceholder.interests")}
          maxLength={PROFILE_LIMITS.interests * (PROFILE_LIMITS.interest + 2)}
          value={draftInterests ?? (profile.data?.interests ?? []).join(", ")}
          onChange={(event) => setDraftInterests(event.target.value)}
          onBlur={() => {
            if (draftInterests == null) return;
            const items = draftInterests
              .split(",")
              .map((item) => item.trim().slice(0, PROFILE_LIMITS.interest))
              .filter(Boolean)
              .slice(0, PROFILE_LIMITS.interests);
            void patch({ interests: items });
            setDraftInterests(null);
          }}
        />
        <div className="px-settings-setup">
          <Button
            shape="round"
            onClick={() => navigate("/onboarding?again=1")}
          >
            {t("settings.runSetup")}
          </Button>
          <p className="small section-hint">{t("settings.runSetupHint")}</p>
        </div>
      </>
    ),
    privacy: (
      <>
        <CrashReportsSwitch
          checked={profile.data?.crashReports === true}
          onChange={(value) => void patch({ crashReports: value })}
        />
      </>
    ),
    reading: (
      <>
        <div className="choice-list">
          <Choice
            label={t("settings.dyslexia")}
            selected={profile.data?.dyslexia === true}
            onClick={() =>
              void patch({ dyslexia: profile.data?.dyslexia !== true })
            }
          />
          {(["sm", "md", "lg"] as const).map((size) => (
            <Choice
              key={size}
              label={t(`settings.text.${size}`)}
              selected={(profile.data?.textSize ?? "md") === size}
              onClick={() => void patch({ textSize: size })}
            />
          ))}
        </div>
        <div className="px-settings-reading-sample reading">
          <p>{t("settings.readingSample")}</p>
        </div>
      </>
    ),
    flashcards: (
      <div className="px-form-field px-settings-cards">
        <label className="label" htmlFor="settings-new-per-day">
          {t("settings.newPerDay")}
        </label>
        <InputNumber
          id="settings-new-per-day"
          min={0}
          max={999}
          precision={0}
          value={draftNewPerDay ?? cardSettings.data?.newPerDay ?? 20}
          onChange={(value) => setDraftNewPerDay(value ?? null)}
          onBlur={() => void saveNewPerDay()}
          onPressEnter={() => void saveNewPerDay()}
          aria-describedby="settings-new-per-day-hint"
        />
        <p className="small section-hint" id="settings-new-per-day-hint">
          {t("settings.newPerDayHint")}
        </p>
      </div>
    ),
    reminders: <RemindersPanel />,
    data: (
      <>
        {place.data ? <p className="small section-hint">{place.data}</p> : null}
        <Button
          shape="round"
          loading={moving}
          disabled={moving}
          onClick={async () => {
            setDataNote(null);
            setMoving(true);
            try {
              const result = await window.pyxis.moveWorkspace();
              if (result.status === "moved") {
                client.setQueryData(["workspace-path"], result.path);
                void client.invalidateQueries({ queryKey: ["plan-usage"] });
                void client.invalidateQueries({ queryKey: ["jobs"] });
                setDataNote(
                  t(
                    result.cleanupPending
                      ? "settings.moveCleanup"
                      : "settings.moveSaved",
                    { path: place.data ?? "" },
                  ),
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
              setDataNote(t(key));
            } finally {
              setMoving(false);
            }
          }}
        >
          {t("settings.move")}
        </Button>
        <p className="small section-hint">{t("settings.moveHint")}</p>
        <div className="label section-label">{t("settings.ocr")}</div>
        <OcrDataCard />
        <ul className="choice-list">
          {(usage.data ?? []).map((plan) => (
            <li key={plan.id} className="small">
              {t("settings.planSize", {
                title: plan.title,
                size: formatBytes(plan.bytes, i18n.language),
              })}
            </li>
          ))}
        </ul>
        <div className="px-settings-actions">
          <Button
            shape="round"
            loading={freeing}
            disabled={moving || archiving !== null}
            onClick={() => {
              if (freeing) return;
              setFreeing(true);
              setFreeNote(null);
              void invoke("plans.freeSpace", {})
                .then(({ bytes }) => {
                  void client.invalidateQueries({ queryKey: ["plan-usage"] });
                  setFreeNote(
                    bytes > 0
                      ? t("settings.freeSpaceDone", { size: formatBytes(bytes, i18n.language) })
                      : t("settings.freeSpaceNothing"),
                  );
                })
                .catch(() => setFreeNote(t("settings.freeSpaceFailed")))
                .finally(() => setFreeing(false));
            }}
          >
            {t("settings.freeSpace")}
          </Button>
        </div>
        <p className="small section-hint" role="status">
          {freeNote ?? t("settings.freeSpaceHint")}
        </p>
        <div className="px-settings-actions">
          <Button
            disabled={moving || (archiving !== null && archiving !== "backup")}
            loading={archiving === "backup"}
            onClick={() => {
              // A second click while the first backup runs used to fail as "workspace busy" and say the backup failed.
              if (archiving) return;
              setArchiving("backup");
              setDataNote(null);
              void window.pyxis
                .backupWorkspace()
                .then((status) => {
                  if (status === "saved")
                    setDataNote(t("settings.backupSaved"));
                })
                .catch((error: unknown) => {
                  setDataNote(backupError(error, locale, t));
                })
                .finally(() => setArchiving(null));
            }}
          >
            {t("settings.backup")}
          </Button>
          <Button
            disabled={moving || (archiving !== null && archiving !== "restore")}
            loading={restoring === "file"}
            danger={restoreArmed === "file"}
            onClick={() => {
              if (archiving) return;
              if (restoreArmed !== "file") {
                setRestoreArmed("file");
                return;
              }
              restore();
            }}
          >
            {restoreArmed === "file"
              ? t("settings.restoreReplace", { workspace: workspaceName })
              : t("settings.restore")}
          </Button>
          {restoreArmed === "file" ? (
            <Button type="text" onClick={() => setRestoreArmed(null)}>
              {t("wizard.cancel")}
            </Button>
          ) : null}
        </div>
        {/* The confirmation and the hint sit under the backup buttons they explain. */}
        {restoreArmed === "file" ? (
          <p className="small section-hint" role="alert">
            {t("settings.restoreConfirm", { workspace: workspaceName })}
          </p>
        ) : (
          <p className="small section-hint">{t("settings.dataHint")}</p>
        )}
        <div className="label section-label">
          {t("settings.autoBackup.title")}
        </div>
        <AutoBackupsSection
          formatSize={(bytes) => formatBytes(bytes, i18n.language)}
        />
        <BackupList
          formatSize={(bytes) => formatBytes(bytes, i18n.language)}
          workspaceName={workspaceName}
          armed={restoreArmed !== "file" ? restoreArmed : null}
          restoring={restoring !== "file" ? restoring : null}
          disabled={moving || archiving !== null}
          onArm={setRestoreArmed}
          onRestore={restore}
        />
        <div className="px-settings-danger">
          <p className="small ink-muted">{t("settings.wipeHint")}</p>
          {wipeArmed ? (
            <div className="px-settings-wipe-backups">
              <Checkbox
                checked={wipeBackups}
                disabled={wiping}
                onChange={(event) => setWipeBackups(event.target.checked)}
              >
                {t("settings.wipeBackups")}
              </Checkbox>
              <p className="small ink-muted" role="alert">
                {wipeBackups
                  ? backupFolder
                    ? t("settings.wipeBackupsFolder", { folder: backupFolder })
                    : null
                  : t("settings.wipeConfirmHint")}
              </p>
            </div>
          ) : null}
          <Button
            disabled={moving || wiping}
            loading={wiping}
            danger
            onClick={() => {
              if (wiping) return;
              if (!wipeArmed) {
                setWipeBackups(true);
                setWipeArmed(true);
                return;
              }
              setDataNote(null);
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
                  setDataNote(
                    t(
                      error instanceof Error &&
                        error.message.includes("wipe-after-keys")
                        ? "settings.wipeKeysCleared"
                        : "settings.wipeFailed",
                    ),
                  );
                });
            }}
          >
            {wipeArmed ? t("settings.wipeConfirm") : t("settings.wipe")}
          </Button>
          {wipeArmed ? (
            <Button
              type="text"
              disabled={wiping}
              onClick={() => setWipeArmed(false)}
            >
              {t("wizard.cancel")}
            </Button>
          ) : null}
        </div>
        {dataNote ? (
          <p className="small section-hint" role="status">
            {dataNote}
          </p>
        ) : null}
      </>
    ),
    language: (
      <>
        <div className="choice-list">
          <Choice
            label={t("settings.italian")}
            selected={locale === "it"}
            onClick={() => setLanguage("it")}
          />
          <Choice
            label={t("settings.english")}
            selected={locale === "en"}
            onClick={() => setLanguage("en")}
          />
        </div>
      </>
    ),
    updates: <UpdatesPanel />,
    about: (
      <>
        {" "}
        <AboutPanel
          labels={{
            title: t("settings.about"),
            version: t("about.version"),
            license: t("about.license"),
            notices: t("about.notices"),
            search: t("about.search"),
            loading: t("about.loading"),
            failed: t("about.failed"),
            empty: t("about.empty"),
            missingText: t("about.missingText"),
          }}
        />
      </>
    ),
    diagnostics: (
      <>
        <p className="small ink-muted">{t("settings.diagnosticsHint")}</p>
        <EnginesPanel />
      </>
    ),
  };
  const active = section && panels[section] ? section : null;
  // The sidebar always has a section open. Profile comes first in the list.
  const shown = twoPane ? (active ?? "profile") : active;
  // Switching sections drops a half-confirmed restore or wipe, like leaving the page does.
  function open(key: string) {
    navigate(`/settings/${key}`);
    setWipeArmed(false);
    setRestoreArmed(null);
  }
  const subpage = shown ? (
    <section className="px-settings-subpage">
      {twoPane ? (
        <h2 className="title-2">
          {labels[shown]}
        </h2>
      ) : null}
      {panels[shown]}
      {params.get("setup") === "1" ? (
        <Button type="primary" shape="round" onClick={() => navigate("/exams")}>
          {t("onboarding.done")}
        </Button>
      ) : null}
    </section>
  ) : null;
  return (
    <div className="px-settings">
      {!twoPane && active ? (
        <Button
          type="text"
          icon={<ArrowLeft size={18} />}
          className="px-settings-back"
          onClick={() => {
            navigate("/settings");
            setWipeArmed(false);
            setRestoreArmed(null);
          }}
        >
          {t("settings.back")}
        </Button>
      ) : null}
      <h1 className="title-1">
        {!twoPane && active ? labels[active] : t("settings.title")}
      </h1>
      {saveError ? (
        <Notice tone="danger">{t("settings.saveFailed")}</Notice>
      ) : null}
      {/* Both layouts share this wrapper and keep the open section in the same slot. Crossing 960 px then re-lays the
          page out without remounting the section, so an open drawer or a half-typed field survives. */}
      <div className={twoPane ? "px-settings-panes" : undefined}>
        {twoPane ? (
          <nav className="px-settings-nav" aria-label={t("settings.title")}>
            {groups.map((group) => (
              <div className="px-settings-nav-group" key={group.name}>
                <h2 className="label">{group.name}</h2>
                {group.rows.map((row) => (
                  <button
                    type="button"
                    className="px-settings-nav-item"
                    key={row.key}
                    aria-current={shown === row.key ? "page" : undefined}
                    onClick={() => open(row.key)}
                  >
                    <row.icon size={18} aria-hidden="true" />
                    <span>{labels[row.key]}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
        ) : null}
        {subpage ??
          (twoPane ? null : (
            <div className="px-settings-groups">
              {groups.map((group) => (
                <section className="px-settings-group" key={group.name}>
                  <h2 className="label">{group.name}</h2>
                  {group.rows.map((row) => (
                    <button
                      type="button"
                      className="px-settings-row"
                      key={row.key}
                      onClick={() => navigate(`/settings/${row.key}`)}
                    >
                      <row.icon size={20} aria-hidden="true" />
                      <span className="body-strong">{labels[row.key]}</span>
                      <span className="meta px-settings-current">{row.value}</span>
                      <ChevronRight size={18} aria-hidden="true" />
                    </button>
                  ))}
                </section>
              ))}
            </div>
          ))}
      </div>
    </div>
  );
}

const GIB = 1024 ** 3;
/** Names the size and the limit when the workspace is too big for one backup. */
function backupError(
  error: unknown,
  locale: Locale,
  t: (key: string, params?: Record<string, string>) => string,
): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("backup-too-many-files"))
    return t("settings.backupTooManyFiles");
  if (message.includes("backup-destination-inside-data"))
    return t("settings.backupInsideData");
  const size = /backup-too-large:(\d+)/.exec(message)?.[1];
  if (!size) return t("settings.backupFailed");
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return t("settings.backupTooLarge", {
    // Rounded up, so a workspace just over the limit never reads as equal to it.
    size: number.format(Math.ceil((Number(size) / GIB) * 10) / 10),
    limit: number.format(2),
  });
}

function Choice(props: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={props.selected ? "choice is-selected" : "choice"}
      aria-pressed={props.selected}
      onClick={props.onClick}
    >
      <span className="body-strong">{props.label}</span>
    </button>
  );
}
