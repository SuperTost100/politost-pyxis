import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { CrashReportsSwitch } from "../../components/CrashReportsSwitch";
import { Notice } from "../../components/Notice";
import { Stepper } from "../../components/Stepper";
import { PROFILE_LIMITS } from "@shared/limits";
import { invoke } from "../../lib/ipc";
import { gradeScaleOf } from "../../lib/grade";
import { useMenuLock } from "../../app/menu-state";
import {
  ExamStep,
  MaterialPrimary,
  MaterialStep,
  useExamDraft,
} from "../plans/ExamDraft";
import { EnginesStep } from "./EnginesStep";
import {
  firstAnswers,
  levels,
  savedProfile,
  type Level,
  type StoredProfile,
} from "./setup";
import "./OnboardingPage.css";
import { profileQuery } from "../../lib/queries";

/**
 * First setup is four steps: about you, the AI engine, the exam, its material. The profile is saved when the engine
 * step ends, so the exam step can be skipped and the student lands on the exams list. A rerun has the first two.
 */
const firstSteps = ["profile", "engines", "exam", "material"] as const;
const rerunSteps = ["profile", "engines"] as const;
type StepId = (typeof firstSteps)[number];

/**
 * First setup, or with `?again=1` (Settings > Profile > Run setup again) the profile and engine steps for a student
 * who already has a profile. A rerun waits for the stored profile so the screens open filled in.
 */
export function OnboardingPage() {
  const [params] = useSearchParams();
  const again = params.get("again") === "1";
  const profile = useQuery({ ...profileQuery, enabled: again });
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
  const steps: readonly StepId[] = again ? rerunSteps : firstSteps;
  const [index, setIndex] = useState(0);
  const [start] = useState(() => firstAnswers(stored));
  const [name, setName] = useState(start.name);
  const [level, setLevel] = useState<Level>(start.level);
  const [year, setYear] = useState(start.year);
  const [school, setSchool] = useState(start.school);
  const [course, setCourse] = useState(start.course);
  // Off for a new install, so nothing is sent unless the student turns it on. A rerun shows the stored choice.
  const [crashReports, setCrashReports] = useState(start.crashReports);
  // Unknown until the engines are read, so the button says Continue rather than flicker to "later".
  const [enginesReady, setEnginesReady] = useState<boolean | null>(null);
  // While the notice of what leaves this computer is open, its "I understand" is the step's one primary button.
  const [engineNoticeOpen, setEngineNoticeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // The exam's goal is shown on the scale of the level just chosen; a new profile has not picked a scale.
  const draft = useExamDraft({
    seed: null,
    scale: gradeScaleOf({ educationLevel: level, gradeScale: null }),
  });
  const heading = useRef<HTMLHeadingElement>(null);
  const id = steps[index]!;

  // A new screen starts at its heading, so keyboard and screen reader users do not land in the old controls.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else heading.current?.focus();
  }, [index]);

  /** Saves the profile. Skip saves an empty one and leaves setup. Resolves with whether it saved. */
  async function save(skip: boolean): Promise<boolean> {
    if (busy) return false;
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
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  // A rerun ends where it started.
  const backToSettings = () => navigate("/settings/profile", { replace: true });
  const next = () => setIndex((value) => Math.min(value + 1, steps.length - 1));
  const back = () => {
    draft.setStartError(null);
    setIndex((value) => Math.max(value - 1, 0));
  };

  // Every screen ends in the same footer: one way back or out on the left, the way forward on the right.
  const backButton = (
    <Button type="text" shape="round" disabled={busy} onClick={back}>
      {t("nav.back")}
    </Button>
  );
  let secondary: ReactNode = null;
  let primary: ReactNode = null;
  if (id === "profile") {
    secondary = again ? (
      <Button type="text" shape="round" onClick={backToSettings}>
        {t("wizard.cancel")}
      </Button>
    ) : (
      <Button
        type="text"
        shape="round"
        disabled={busy}
        onClick={() =>
          void save(true).then((saved) => {
            if (saved) navigate("/exams");
          })
        }
      >
        {t("onboarding.skip")}
      </Button>
    );
    primary = (
      <Button type="primary" shape="round" onClick={next}>
        {t("onboarding.continue")}
      </Button>
    );
  } else if (id === "engines") {
    secondary = backButton;
    primary = (
      <Button
        type={engineNoticeOpen ? "default" : "primary"}
        shape="round"
        loading={busy}
        onClick={() =>
          void save(false).then((saved) => {
            if (!saved) return;
            if (again) backToSettings();
            else next();
          })
        }
      >
        {t(
          again
            ? "onboarding.again.done"
            : enginesReady === false
              ? "onboarding.later"
              : "onboarding.continue",
        )}
      </Button>
    );
  } else if (id === "exam") {
    secondary = backButton;
    primary = (
      <>
        {/* The profile is saved: without an exam to set up, the exams list has the way to create one later. */}
        <Button shape="round" onClick={() => navigate("/exams")}>
          {t("onboarding.exam.skip")}
        </Button>
        <Button
          type="primary"
          shape="round"
          disabled={!draft.examReady}
          aria-describedby={!draft.title.trim() ? "onboarding-title-required" : undefined}
          onClick={next}
        >
          {t("onboarding.continue")}
        </Button>
      </>
    );
  } else {
    secondary = backButton;
    primary = (
      <MaterialPrimary
        draft={draft}
        onCreated={(planId) => navigate(`/plans/new?build=${planId}`)}
      />
    );
  }

  return (
    <div className="px-onboarding">
      <Stepper
        steps={steps.map((item) => t(`onboarding.steps.${item}`))}
        current={index}
      />
      <h1 className="display" tabIndex={-1} ref={heading}>
        {t(`onboarding.${id}.title`)}
      </h1>
      {id === "exam" ? null : (
        <p className="body">{t(`onboarding.${id}.body`)}</p>
      )}

      {id === "profile" ? (
        <ProfileStep
          values={{ name, level, year, school, course }}
          set={{ setName, setLevel, setYear, setSchool, setCourse }}
        />
      ) : null}
      {id === "engines" ? (
        <>
          <EnginesStep
            onReady={setEnginesReady}
            onNotice={setEngineNoticeOpen}
            again={again}
          />
          <CrashReportsSwitch
            checked={crashReports}
            disabled={busy}
            onChange={setCrashReports}
          />
        </>
      ) : null}
      {id === "exam" ? (
        <>
          <ExamStep draft={draft} />
          {!draft.title.trim() ? (
            <p id="onboarding-title-required" className="small px-onboarding-note">
              {t("wizard.titleRequired")}
            </p>
          ) : null}
        </>
      ) : null}
      {id === "material" ? <MaterialStep draft={draft} /> : null}

      {draft.startError ? (
        <p className="small" role="alert">
          {t(draft.startError)}
        </p>
      ) : null}
      {failed ? (
        <Notice tone="danger">{t("onboarding.saveFailed")}</Notice>
      ) : null}
      <div className="px-onboarding-actions">
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
          {t("onboarding.nameQuestion")}
        </label>
        <Input
          id="profile-name"
          maxLength={PROFILE_LIMITS.displayName}
          value={values.name}
          onChange={(event) => set.setName(event.target.value)}
        />
      </div>
      <div className="px-form-field">
        <div className="label section-label" id="profile-level">
          {t("onboarding.level")}
        </div>
        <div
          className="choice-list px-profile-levels"
          role="group"
          aria-labelledby="profile-level"
          aria-describedby="profile-level-help"
        >
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
        <p className="small px-onboarding-note" id="profile-level-help">
          {t("onboarding.levelHelp")}
        </p>
      </div>
      <div className="px-form-grid">
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
      </div>
    </>
  );
}
