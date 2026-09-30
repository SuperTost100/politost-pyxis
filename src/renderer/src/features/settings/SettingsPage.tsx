import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { useAppState } from "../../app/app-state";
import { invoke } from "../../lib/ipc";
import { i18n, setLanguage, type Locale } from "../../locales/i18n";
import { EnginesPanel } from "./EnginesPanel";

export function SettingsPage() {
  const { t } = useTranslation();
  const { appearance, setTheme } = useAppState();
  const locale: Locale = i18n.language === "en" ? "en" : "it";
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => invoke("profile.get", {}),
  });

  const [draftInterests, setDraftInterests] = useState<string | null>(null);
  const [dataNote, setDataNote] = useState<string | null>(null);

  async function patch(input: {
    dyslexia?: boolean;
    textSize?: "sm" | "md" | "lg";
    tutorMode?: "solver" | "socratic";
    interests?: string[];
    interestsOn?: boolean;
    crashReports?: boolean;
  }) {
    const saved = await invoke("profile.save", input);
    client.setQueryData(["profile"], saved);
    document.documentElement.dataset.dyslexia = saved.dyslexia ? "on" : "off";
    document.documentElement.dataset.text = saved.textSize;
  }
  return (
    <div>
      <h1 className="title-1">{t("settings.title")}</h1>
      <div className="label section-label">{t("settings.appearance")}</div>
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
      <EnginesPanel />
      {params.get("setup") === "1" ? (
        <div className="gallery-row">
          <Button type="primary" shape="round" onClick={() => navigate("/exams")}>
            {t("onboarding.done")}
          </Button>
        </div>
      ) : null}
      <div className="label section-label">{t("settings.tutor")}</div>
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
      <div className="label section-label">{t("settings.interests")}</div>
      <div className="choice-list">
        <Choice
          label={t("settings.interestsOn")}
          selected={profile.data?.interestsOn !== false}
          onClick={() => void patch({ interestsOn: profile.data?.interestsOn === false })}
        />
      </div>
      <Input
        aria-label={t("settings.interests")}
        value={draftInterests ?? (profile.data?.interests ?? []).join(", ")}
        onChange={(event) => setDraftInterests(event.target.value)}
        onBlur={() => {
          const items = (draftInterests ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
          void patch({ interests: items });
          setDraftInterests(null);
        }}
      />
      <div className="label section-label">{t("settings.privacy")}</div>
      <div className="choice-list">
        <Choice
          label={t("settings.crashReports")}
          selected={profile.data?.crashReports === true}
          onClick={() => void patch({ crashReports: profile.data?.crashReports !== true })}
        />
      </div>
      <p className="small section-hint">{t("settings.crashHint")}</p>
      <div className="label section-label">{t("settings.reading")}</div>
      <div className="choice-list">
        <Choice
          label={t("settings.dyslexia")}
          selected={profile.data?.dyslexia === true}
          onClick={() => void patch({ dyslexia: profile.data?.dyslexia !== true })}
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
      <div className="label section-label">{t("settings.data")}</div>
      <div className="choice-list">
        <Button
          onClick={() => {
            setDataNote(null);
            void window.pyxis.backupWorkspace().catch(() => {
              setDataNote(t("settings.backupFailed"));
            });
          }}
        >
          {t("settings.backup")}
        </Button>
        <Button
          onClick={() => {
            setDataNote(null);
            void window.pyxis.restoreWorkspace().catch(() => {
              setDataNote(t("settings.restoreFailed"));
            });
          }}
        >
          {t("settings.restore")}
        </Button>
      </div>
      <p className="small section-hint">{dataNote ?? t("settings.dataHint")}</p>
      <div className="label section-label">{t("settings.language")}</div>
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
    </div>
  );
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
