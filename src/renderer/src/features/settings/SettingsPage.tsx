import { AboutPanel } from "./AboutPanel";
import { UpdatesPanel } from "./UpdatesPanel";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "antd";
import {
  ArrowLeft,
  ChevronRight,
  UserRound,
  BookOpen,
  Cpu,
  Palette,
  Languages,
  HardDrive,
  Shield,
  RefreshCw,
  Info,
  ALargeSmall,
  Terminal,
} from "lucide-react";
import { CrashReportsSwitch } from "../../components/CrashReportsSwitch";
import { Notice } from "../../components/Notice";
import { OcrDataCard } from "../../components/OcrData";
import "./SettingsPage.css";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useAppState } from "../../app/app-state";
import { invoke } from "../../lib/ipc";
import { i18n, setLanguage, type Locale } from "../../locales/i18n";
import { EnginesPanel } from "./EnginesPanel";

const levels = [
  "primary",
  "lower-secondary",
  "upper-secondary",
  "technical",
  "vocational",
  "university",
  "other",
] as const;

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
  const client = useQueryClient();
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => invoke("profile.get", {}),
  });

  const [saveError, setSaveError] = useState(false);
  const [draftInterests, setDraftInterests] = useState<string | null>(null);
  const [dataNote, setDataNote] = useState<string | null>(null);
  const [wipeArmed, setWipeArmed] = useState(false);
  const [restoreArmed, setRestoreArmed] = useState(false);
  const [moving, setMoving] = useState(false);
  const place = useQuery({
    queryKey: ["workspace-path"],
    queryFn: () => window.pyxis.workspacePath(),
  });
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
  const workspaceName =
    place.data?.split(/[\\/]/).filter(Boolean).at(-1) ??
    t("settings.workspaceThis");
  const labels: Record<string, string> = {
    profile: t("settings.profile"),
    engines: t("settings.enginesTitle"),
    tutor: t("settings.tutor"),
    reading: t("settings.reading"),
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
  const groups = [
    {
      name: t("settings.groups.profile"),
      rows: [
        {
          key: "profile",
          icon: UserRound,
          value: profile.data?.displayName ?? "",
        },
      ],
    },
    {
      name: t("settings.groups.engines"),
      rows: [{ key: "engines", icon: Cpu, value: "" }],
    },
    {
      name: t("settings.groups.study"),
      rows: [
        {
          key: "tutor",
          icon: BookOpen,
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
          key: "appearance",
          icon: Palette,
          value: t(`settings.${appearance.source}`),
        },
        {
          key: "language",
          icon: Languages,
          value: t(locale === "it" ? "settings.italian" : "settings.english"),
        },
      ],
    },
    {
      name: t("settings.groups.data"),
      rows: [{ key: "data", icon: HardDrive, value: "" }],
    },
    {
      name: t("settings.groups.app"),
      rows: [
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
          value={draftInterests ?? (profile.data?.interests ?? []).join(", ")}
          onChange={(event) => setDraftInterests(event.target.value)}
          onBlur={() => {
            if (draftInterests == null) return;
            const items = draftInterests
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean);
            void patch({ interests: items });
            setDraftInterests(null);
          }}
        />
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
                size: formatBytes(plan.bytes),
              })}
            </li>
          ))}
        </ul>
        <div className="choice-list">
          <Button
            disabled={moving}
            onClick={() => {
              setDataNote(null);
              void window.pyxis
                .backupWorkspace()
                .then((status) => {
                  if (status === "saved")
                    setDataNote(t("settings.backupSaved"));
                })
                .catch(() => {
                  setDataNote(t("settings.backupFailed"));
                });
            }}
          >
            {t("settings.backup")}
          </Button>
          <Button
            disabled={moving}
            danger={restoreArmed}
            onClick={() => {
              if (!restoreArmed) {
                setRestoreArmed(true);
                return;
              }
              setRestoreArmed(false);
              setDataNote(null);
              void window.pyxis
                .restoreWorkspace()
                .then((status) => {
                  if (status === "restored") {
                    // Drafts, board strokes and staged files belong to the replaced workspace.
                    sessionStorage.clear();
                    window.location.reload();
                  }
                })
                .catch(() => {
                  setDataNote(t("settings.restoreFailed"));
                });
            }}
          >
            {restoreArmed
              ? t("settings.restoreReplace", { workspace: workspaceName })
              : t("settings.restore")}
          </Button>
          {restoreArmed ? (
            <Button type="text" onClick={() => setRestoreArmed(false)}>
              {t("wizard.cancel")}
            </Button>
          ) : null}
        </div>
        <div className="px-settings-danger">
          <p className="small ink-muted">{t("settings.wipeHint")}</p>
          <Button
            disabled={moving}
            danger
            onClick={() => {
              if (!wipeArmed) {
                setWipeArmed(true);
                return;
              }
              setDataNote(null);
              void window.pyxis
                .wipeWorkspace()
                .then(() => {
                  // The reload keeps sessionStorage, so clear drafts, board data and last paths of the deleted workspace first.
                  sessionStorage.clear();
                  window.location.reload();
                })
                .catch((error: unknown) => {
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
            <Button type="text" onClick={() => setWipeArmed(false)}>
              {t("wizard.cancel")}
            </Button>
          ) : null}
        </div>
        {restoreArmed ? (
          <p className="small section-hint" role="alert">
            {t("settings.restoreConfirm", { workspace: workspaceName })}
          </p>
        ) : null}
        {dataNote ? (
          <p className="small section-hint" role="status">
            {dataNote}
          </p>
        ) : null}
        <p className="small section-hint">{t("settings.dataHint")}</p>
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
  return (
    <div className="px-settings">
      {active ? (
        <Button
          type="text"
          icon={<ArrowLeft size={18} />}
          className="px-settings-back"
          onClick={() => {
            navigate("/settings");
            setWipeArmed(false);
            setRestoreArmed(false);
          }}
        >
          {t("settings.back")}
        </Button>
      ) : null}
      <h1 className="title-1">
        {active ? labels[active] : t("settings.title")}
      </h1>
      {saveError ? (
        <Notice tone="danger">{t("settings.saveFailed")}</Notice>
      ) : null}
      {active ? (
        <section className="px-settings-subpage">
          {panels[active]}
          {params.get("setup") === "1" ? (
            <Button
              type="primary"
              shape="round"
              onClick={() => navigate("/exams")}
            >
              {t("onboarding.done")}
            </Button>
          ) : null}
        </section>
      ) : (
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
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round(bytes / 1024)} KB`;
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
