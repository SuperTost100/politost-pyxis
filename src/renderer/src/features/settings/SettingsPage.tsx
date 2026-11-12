import { AboutPanel } from "./AboutPanel";
import { UpdatesPanel } from "./UpdatesPanel";
import { DataPanel } from "./DataPanel";
import { ProfilePanel, type ProfilePatch } from "./ProfilePanel";
import { RemindersPanel } from "./RemindersPanel";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import {
  ArrowLeft,
  ChevronRight,
  GraduationCap,
  Info,
  Plug,
  Shield,
  Sun,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { ControlList, ControlRow, PreviewTiles, Segmented, Stepper, SwitchRow } from "../../components/Controls";
import { Notice } from "../../components/Notice";
import "./SettingsPage.css";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useAppState } from "../../app/app-state";
import { invoke } from "../../lib/ipc";
import { i18n, setLanguage, type Locale } from "../../locales/i18n";
import { EnginesPanel } from "./EnginesPanel";
import { useProfile } from "../../lib/queries";

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

type PageKey = "profile" | "engines" | "study" | "appearance" | "data" | "about";

/** The six pages (pyxis-mockups app/index.html, "s-settings") and the sections each holds, in order. */
const PAGES: Array<{ key: PageKey; icon: LucideIcon; sections: string[] }> = [
  { key: "profile", icon: UserRound, sections: ["profile"] },
  { key: "engines", icon: Plug, sections: ["engines"] },
  { key: "study", icon: GraduationCap, sections: ["tutor", "reading", "flashcards", "reminders"] },
  { key: "appearance", icon: Sun, sections: ["appearance", "language"] },
  // Data draws its four groups itself (backups, privacy and wipe have their own ids), so a link to one still lands there.
  { key: "data", icon: Shield, sections: ["data"] },
  { key: "about", icon: Info, sections: ["updates", "version"] },
];

/**
 * The page that holds each section. Links name a section, as /settings/updates does, and open its page scrolled to it.
 * Engine diagnostics were a second copy of the engines panel, which has them inside.
 */
const PAGE_OF: Record<string, PageKey> = {
  ...Object.fromEntries(PAGES.flatMap((page) => page.sections.map((section) => [section, page.key]))),
  ...Object.fromEntries(PAGES.map((page) => [page.key, page.key])),
  diagnostics: "engines",
  backups: "data",
  privacy: "data",
  wipe: "data",
};

/**
 * A small window drawn in a theme, for its preview tile: the sidebar, a title, a card and the primary button, in the
 * theme's own tokens. System shows light and dark split on the diagonal.
 */
function ThemePreview({ theme }: { theme: "system" | "light" | "dark" }) {
  const mini = (mode: "light" | "dark") => (
    <span className="px-theme-mini" data-theme={mode} key={mode}>
      <i className="px-theme-mini-side" />
      <i className="px-theme-mini-title" />
      <i className="px-theme-mini-card" />
      <i className="px-theme-mini-button" />
    </span>
  );
  return theme === "system" ? [mini("light"), mini("dark")] : mini(theme);
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
  async function saveNewPerDay(value: number) {
    if (value === cardSettings.data?.newPerDay) return;
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
  const profileSaves = useRef({ chain: Promise.resolve(), pending: 0, failed: false });
  async function patch(input: ProfilePatch) {
    setSaveError(false);
    // The control shows the choice at once. Saves run one after another; the stored profile replaces the shown one only
    // once none is left, so a quick second change doesn't flicker back, and a failure reloads what is stored.
    const shown = client.getQueryData<Record<string, unknown>>(["profile"]);
    if (shown) client.setQueryData(["profile"], { ...shown, ...input });
    profileSaves.current.pending += 1;
    const run = profileSaves.current.chain.then(async () => {
      try {
        const saved = await invoke("profile.save", input);
        document.documentElement.dataset.dyslexia = saved.dyslexia ? "on" : "off";
        document.documentElement.dataset.text = saved.textSize;
        if (profileSaves.current.pending === 1) client.setQueryData(["profile"], saved);
      } catch {
        setSaveError(true);
        profileSaves.current.failed = true;
      } finally {
        profileSaves.current.pending -= 1;
        if (profileSaves.current.pending === 0 && profileSaves.current.failed) {
          profileSaves.current.failed = false;
          await client.invalidateQueries({ queryKey: ["profile"] });
        }
      }
    });
    profileSaves.current.chain = run;
    await run;
  }
  const labels: Record<string, string> = {
    engines: t("settings.enginesTitle"),
    tutor: t("settings.tutor"),
    reading: t("settings.reading"),
    flashcards: t("settings.flashcards"),
    reminders: t("settings.reminders.title"),
    appearance: t("settings.theme"),
    language: t("settings.language"),
    updates: t("updates.title"),
    version: t("settings.aboutBlock"),
  };
  const panels: Record<string, ReactNode> = {
    appearance: (
      <>
        <p className="px-settings-block-hint">{t("settings.themeHint")}</p>
        <PreviewTiles
          label="settings-appearance-title"
          value={appearance.source}
          options={(["system", "light", "dark"] as const).map((value) => ({
            value,
            label: t(`settings.${value}`),
            preview: <ThemePreview theme={value} />,
          }))}
          onChange={(value) => setTheme(value)}
        />
      </>
    ),
    engines: <EnginesPanel />,
    tutor: (
      <>
        <ControlList>
          <SwitchRow
            title={t("settings.how.followups")}
            description={t("settings.how.followupsHint")}
            checked={profile.data?.followups !== false}
            onChange={(followups) => void patch({ followups })}
          />
        </ControlList>
      </>
    ),
    profile: <ProfilePanel profile={profile.data} patch={patch} />,
    reading: (
      <>
        <ControlList>
          <ControlRow id="settings-text-size" title={t("settings.textSize")}>
            <Segmented
              label="settings-text-size"
              value={profile.data?.textSize ?? "md"}
              options={(["sm", "md", "lg"] as const).map((value) => ({ value, label: t(`settings.size.${value}`) }))}
              onChange={(textSize) => void patch({ textSize })}
            />
          </ControlRow>
          <SwitchRow
            title={t("settings.dyslexia")}
            description={t("settings.dyslexiaHint")}
            checked={profile.data?.dyslexia === true}
            onChange={(dyslexia) => void patch({ dyslexia })}
          />
        </ControlList>
        <div className="px-settings-preview">
          <span className="label">{t("settings.preview")}</span>
          <p className="reading">{t("settings.readingSample")}</p>
        </div>
      </>
    ),
    flashcards: (
      <ControlList>
        <ControlRow
          id="settings-new-per-day"
          title={t("settings.newPerDay")}
          description={t("settings.newPerDayExample", {
            count: cardSettings.data?.newPerDay ?? 20,
            total: (cardSettings.data?.newPerDay ?? 20) * 3,
          })}
        >
          <Stepper
            label="settings-new-per-day"
            value={cardSettings.data?.newPerDay ?? 20}
            min={0}
            max={999}
            step={5}
            decreaseLabel={t("settings.fewer")}
            increaseLabel={t("settings.more")}
            disabled={!cardSettings.data}
            onChange={(value) => void saveNewPerDay(value)}
          />
        </ControlRow>
      </ControlList>
    ),
    reminders: <RemindersPanel />,
    data: (
      <DataPanel
        crashReports={profile.data?.crashReports === true}
        onCrashReports={(crashReports) => void patch({ crashReports })}
      />
    ),
    language: (
      <ControlList>
        <ControlRow id="settings-language-row" title={t("settings.languageRow")} description={t("settings.languageRowHint")}>
          <Segmented
            label="settings-language-row"
            value={locale}
            options={[
              { value: "it", label: t("settings.italian") },
              { value: "en", label: t("settings.english") },
            ]}
            onChange={setLanguage}
          />
        </ControlRow>
      </ControlList>
    ),
    updates: <UpdatesPanel />,
    version: (
      <>
        <AboutPanel
          labels={{
            title: t("settings.aboutBlock"),
            version: t("about.version"),
            commit: t("about.commit"),
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
  };
  const active = section ? (PAGE_OF[section] ?? null) : null;
  // Two panes always have a page open. Profile comes first in the list.
  const shown = twoPane ? (active ?? "profile") : active;
  const page = PAGES.find((item) => item.key === shown);
  // A link to one section of a page opens the page at that section.
  useEffect(() => {
    if (!section || section === active) return;
    const target = document.getElementById(`settings-${section}`);
    // A section that fits the window scrolls only as far as it needs, so one already in view leaves the page's titles in
    // place. A taller one brings its heading to the top: "nearest" would do nothing while the window sits inside it. An
    // old name with no section of its own, such as diagnostics, opens its page at the top.
    if (!target) window.scrollTo({ top: 0 });
    else if (target.getBoundingClientRect().height <= window.innerHeight) target.scrollIntoView({ block: "nearest" });
    else (target.querySelector("h2") ?? target).scrollIntoView({ block: "start" });
  }, [section, active]);
  // Switching pages unmounts the page, so a half-confirmed restore or wipe goes with it, like leaving Settings does.
  function open(key: string) {
    navigate(key ? `/settings/${key}` : "/settings");
  }
  const pageName = (key: PageKey) => t(`settings.pages.${key}`);
  const subpage = page ? (
    <div className="px-settings-page">
      <header className="px-settings-head">
        <h1 className="title-1">{pageName(page.key)}</h1>
        <p>{t(`settings.pageIntro.${page.key}`)}</p>
      </header>
      {saveError ? <Notice tone="danger">{t("settings.saveFailed")}</Notice> : null}
      {page.sections.map((key) => {
        // A page of one section is titled by the page; Updates and the version title themselves.
        const titled = page.sections.length > 1 && key !== "updates" && key !== "version";
        return (
          <section
            key={key}
            id={`settings-${key}`}
            className="px-settings-subpage"
            aria-labelledby={titled ? `settings-${key}-title` : undefined}
          >
            {titled ? (
              <h2 className="px-settings-block-title" id={`settings-${key}-title`}>
                {labels[key]}
              </h2>
            ) : null}
            {panels[key]}
          </section>
        );
      })}
      {params.get("setup") === "1" ? (
        <Button type="primary" shape="round" className="px-settings-done" onClick={() => navigate("/ask")}>
          {t("onboarding.done")}
        </Button>
      ) : null}
    </div>
  ) : null;
  const hint = (key: PageKey) =>
    key === "study" ? t("settings.studyHint") : key === "profile" ? (profile.data?.displayName ?? "") : "";
  return (
    // Both layouts share this wrapper and keep the open page in the same slot. Crossing 960 px then re-lays the page
    // out without remounting it, so an open drawer or a half-typed field survives.
    <div className={twoPane ? "px-settings px-settings-panes" : "px-settings"}>
      {twoPane ? (
        <nav className="px-settings-nav" aria-label={t("settings.title")}>
          <h2>{t("settings.title")}</h2>
          {PAGES.map((item) => (
            <button
              type="button"
              className={item.key === "about" ? "px-settings-nav-item is-foot" : "px-settings-nav-item"}
              key={item.key}
              aria-current={shown === item.key ? "page" : undefined}
              onClick={() => open(item.key)}
            >
              <item.icon size={18} strokeWidth={1.75} aria-hidden="true" />
              <span>{pageName(item.key)}</span>
              {item.key === "study" ? <small aria-hidden="true">{hint(item.key)}</small> : null}
            </button>
          ))}
        </nav>
      ) : active ? (
        <Button type="text" icon={<ArrowLeft size={18} />} className="px-settings-back" onClick={() => open("")}>
          {t("settings.back")}
        </Button>
      ) : null}
      {subpage ?? (
        <>
          <h1 className="title-1">{t("settings.title")}</h1>
          {saveError ? <Notice tone="danger">{t("settings.saveFailed")}</Notice> : null}
          <div className="px-settings-list">
            {PAGES.map((item) => (
              <button
                type="button"
                className="px-settings-row"
                key={item.key}
                onClick={() => open(item.key)}
              >
                <item.icon size={20} strokeWidth={1.75} aria-hidden="true" />
                <span className="body-strong">{pageName(item.key)}</span>
                <span className="small px-settings-current">{hint(item.key)}</span>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
