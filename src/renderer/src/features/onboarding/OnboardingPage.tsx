import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { CrashReportsSwitch } from "../../components/CrashReportsSwitch";
import { Notice } from "../../components/Notice";
import { OcrDataCard } from "../../components/OcrData";
import { Stepper } from "../../components/Stepper";
import { PROFILE_LIMITS } from "@shared/limits";
import { invoke } from "../../lib/ipc";
import { useMenuLock } from "../../app/menu-state";
import { useJobs } from "../jobs/queries";
import { EnginesStep } from "./EnginesStep";
import {
  firstAnswers,
  levels,
  savedProfile,
  type Level,
  type StoredProfile,
} from "./setup";
import "./OnboardingPage.css";

/** The numbered setup steps. A welcome screen comes before them and a "ready" screen after. */
const stepIds = ["profile", "engines", "photos", "privacy"] as const;
const screens = ["welcome", ...stepIds, "ready"] as const;
type ScreenId = (typeof screens)[number];

/**
 * First setup, or with `?again=1` (Settings > Profile > Run setup again) the same screens for a student who already
 * has a profile. A rerun waits for the stored profile so the screens open filled in.
 */
export function OnboardingPage() {
  const [params] = useSearchParams();
  const again = params.get("again") === "1";
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => invoke("profile.get", {}),
    enabled: again,
  });
  if (again && profile.isPending) return null;
  // A rerun link without a profile is a first setup.
  return <Setup stored={again ? (profile.data ?? null) : null} />;
}

function Setup({ stored }: { stored: StoredProfile | null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  // Setup is not left through the menu: Shell sends a profile-less student back here, and a rerun has its own Cancel.
  useMenuLock(true);
  const again = stored !== null;
  const [screen, setScreen] = useState(0);
  const [start] = useState(() => firstAnswers(stored));
  const [name, setName] = useState(start.name);
  const [level, setLevel] = useState<Level>(start.level);
  const [year, setYear] = useState(start.year);
  const [school, setSchool] = useState(start.school);
  const [course, setCourse] = useState(start.course);
  // On for a new install, so the student sees the switch already on and can turn it off. A rerun shows the stored choice.
  const [crashReports, setCrashReports] = useState(start.crashReports);
  // Unknown until the engines are read, so the button says Continue rather than flicker to "later".
  const [enginesReady, setEnginesReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const id: ScreenId = screens[screen]!;
  const step = screen - 1;
  const numbered = step >= 0 && step < stepIds.length;

  // A new screen starts at its heading, so keyboard and screen reader users do not land in the old controls.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else heading.current?.focus();
  }, [screen]);

  /** Saves the profile. Skip saves an empty one and leaves setup; otherwise the "ready" screen follows. */
  async function finish(skip: boolean) {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await invoke(
        "profile.save",
        skip
          ? { displayName: "" }
          : savedProfile(
              { name, level, year, school, course, crashReports },
              t("onboarding.contentLanguage"),
              stored,
            ),
      );
      await client.invalidateQueries({ queryKey: ["profile"] });
      if (skip) navigate("/exams");
      else setScreen(screens.indexOf("ready"));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  // A rerun ends where it started.
  const backToSettings = () => navigate("/settings/profile", { replace: true });
  const next = () =>
    setScreen((value) => Math.min(value + 1, screens.length - 1));
  const back = () => setScreen((value) => Math.max(value - 1, 0));

  // Every screen ends in the same footer: one way back or out on the left, the way forward on the right.
  const skipButton = (
    <Button
      type="text"
      shape="round"
      disabled={busy}
      onClick={() => void finish(true)}
    >
      {t("onboarding.skip")}
    </Button>
  );
  const backButton = (
    <Button type="text" shape="round" disabled={busy} onClick={back}>
      {t("nav.back")}
    </Button>
  );
  const continueButton = (
    onClick: () => void,
    label = "onboarding.continue",
  ) => (
    <Button type="primary" shape="round" onClick={onClick}>
      {t(label)}
    </Button>
  );
  let secondary: ReactNode = null;
  let primary: ReactNode = null;
  if (id === "welcome") {
    secondary = again ? (
      <Button type="text" shape="round" onClick={backToSettings}>
        {t("wizard.cancel")}
      </Button>
    ) : (
      skipButton
    );
    primary = continueButton(next, "onboarding.welcome.start");
  } else if (id === "ready") {
    if (again) {
      primary = continueButton(backToSettings, "onboarding.again.done");
    } else {
      secondary = (
        <Button type="text" shape="round" onClick={() => navigate("/exams")}>
          {t("onboarding.done")}
        </Button>
      );
      primary = (
        <>
          <Button
            shape="round"
            onClick={() => navigate("/plans/new", { state: { books: true } })}
          >
            {t("onboarding.ready.book")}
          </Button>
          {continueButton(
            () => navigate("/plans/new"),
            "onboarding.ready.create",
          )}
        </>
      );
    }
  } else {
    secondary = id === "profile" && !again ? skipButton : backButton;
    if (id === "engines")
      primary = continueButton(
        next,
        enginesReady === false ? "onboarding.later" : "onboarding.continue",
      );
    else if (id === "privacy")
      primary = (
        <Button
          type="primary"
          shape="round"
          loading={busy}
          onClick={() => void finish(false)}
        >
          {t("onboarding.continue")}
        </Button>
      );
    else primary = continueButton(next);
  }

  return (
    <div className="px-onboarding">
      {numbered ? (
        <Stepper
          steps={stepIds.map((item) => t(`onboarding.steps.${item}`))}
          current={step}
        />
      ) : null}
      <h1 className="display" tabIndex={-1} ref={heading}>
        {t(
          id === "profile"
            ? "onboarding.title"
            : again && id === "ready"
              ? "onboarding.again.readyTitle"
              : `onboarding.${id}.title`,
        )}
      </h1>
      <p className="body">
        {t(
          id === "profile"
            ? "onboarding.body"
            : again && id === "ready"
              ? "onboarding.again.readyBody"
              : `onboarding.${id}.body`,
        )}
      </p>

      {id === "welcome" ? (
        <ul className="px-onboarding-points">
          {(["plan", "local", "account", "time"] as const).map((point) => (
            <li key={point} className="body">
              {t(`onboarding.welcome.points.${point}`)}
            </li>
          ))}
        </ul>
      ) : null}

      {id === "profile" ? (
        <ProfileStep
          values={{ name, level, year, school, course }}
          set={{ setName, setLevel, setYear, setSchool, setCourse }}
        />
      ) : null}
      {id === "engines" ? (
        <EnginesStep onReady={setEnginesReady} again={again} />
      ) : null}
      {id === "photos" ? <PhotosStep /> : null}
      {id === "privacy" ? (
        <CrashReportsSwitch
          checked={crashReports}
          disabled={busy}
          onChange={setCrashReports}
        />
      ) : null}

      {failed ? (
        <Notice tone="danger">{t("onboarding.saveFailed")}</Notice>
      ) : null}
      <div
        className={
          id === "ready" && !again
            ? "px-onboarding-actions is-ready"
            : "px-onboarding-actions"
        }
      >
        <span>{secondary}</span>
        <span className="px-onboarding-primary">{primary}</span>
      </div>
    </div>
  );
}

function ProfileStep(props: {
  values: {
    name: string;
    level: (typeof levels)[number];
    year: string;
    school: string;
    course: string;
  };
  set: {
    setName: (value: string) => void;
    setLevel: (value: (typeof levels)[number]) => void;
    setYear: (value: string) => void;
    setSchool: (value: string) => void;
    setCourse: (value: string) => void;
  };
}) {
  const { t } = useTranslation();
  const { values, set } = props;
  return (
    <>
      <div className="px-form-field">
        <label className="label" htmlFor="profile-name">
          {t("onboarding.name")}
        </label>
        <Input
          id="profile-name"
          maxLength={PROFILE_LIMITS.displayName}
          value={values.name}
          onChange={(event) => set.setName(event.target.value)}
        />
      </div>
      <div className="label section-label">{t("onboarding.level")}</div>
      <div className="choice-list px-profile-levels">
        {levels.map((item) => (
          <button
            key={item}
            type="button"
            className={item === values.level ? "choice is-selected" : "choice"}
            aria-pressed={item === values.level}
            onClick={() => set.setLevel(item)}
          >
            {t(`onboarding.levels.${item}`)}
          </button>
        ))}
      </div>
      <div className="px-form-grid">
        <div className="px-form-field">
          <label className="label" htmlFor="profile-year">
            {t("onboarding.year")}
          </label>
          <Input
            id="profile-year"
            maxLength={PROFILE_LIMITS.year}
            value={values.year}
            onChange={(event) => set.setYear(event.target.value)}
          />
        </div>
        <div className="px-form-field">
          <label className="label" htmlFor="profile-school">
            {t("onboarding.school")}
          </label>
          <Input
            id="profile-school"
            maxLength={PROFILE_LIMITS.school}
            value={values.school}
            onChange={(event) => set.setSchool(event.target.value)}
          />
        </div>
        <div className="px-form-field">
          <label className="label" htmlFor="profile-course">
            {t("onboarding.course")}
          </label>
          <Input
            id="profile-course"
            maxLength={PROFILE_LIMITS.course}
            value={values.course}
            onChange={(event) => set.setCourse(event.target.value)}
          />
        </div>
      </div>
    </>
  );
}

/**
 * The same one-time OCR language download as Settings > Data, with its own consent text, progress and retry. Not
 * downloading is the default: Continue in the footer moves on, and a running download keeps going.
 */
function PhotosStep() {
  const { t } = useTranslation();
  const { data: jobs = [] } = useJobs();
  const downloading = jobs.some(
    (job) =>
      job.kind === "ocr-data-download" &&
      (job.state === "queued" || job.state === "running"),
  );
  return (
    <div className="px-onboarding-photos">
      <OcrDataCard />
      {downloading ? (
        <p className="small px-onboarding-note">
          {t("onboarding.photos.keepGoing")}
        </p>
      ) : null}
    </div>
  );
}
