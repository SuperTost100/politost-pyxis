import { useQueryClient } from "@tanstack/react-query";
import { Button, Input, Steps } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { CrashReportsSwitch } from "../../components/CrashReportsSwitch";
import { Notice } from "../../components/Notice";
import { OcrDataCard } from "../../components/OcrData";
import { invoke } from "../../lib/ipc";
import { useJobs } from "../jobs/queries";
import { EnginesStep } from "./EnginesStep";
import "./OnboardingPage.css";

const levels = [
  "primary",
  "lower-secondary",
  "upper-secondary",
  "technical",
  "vocational",
  "university",
  "other",
] as const;
const stepIds = ["profile", "engines", "photos", "privacy"] as const;
type StepId = (typeof stepIds)[number];

export function OnboardingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [level, setLevel] = useState<(typeof levels)[number]>("university");
  const [year, setYear] = useState("");
  const [school, setSchool] = useState("");
  const [course, setCourse] = useState("");
  // On for a new install. The student sees the switch already on and can turn it off before finishing.
  const [crashReports, setCrashReports] = useState(true);
  // Unknown until the engines are read, so the button says Continue rather than flicker to "later".
  const [enginesReady, setEnginesReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const id: StepId = stepIds[step]!;

  // A new screen starts at its heading, so keyboard and screen reader users do not land in the old controls.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else heading.current?.focus();
  }, [step]);

  async function finish(skip: boolean) {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await invoke(
        "profile.save",
        skip
          ? { displayName: "" }
          : {
              displayName: name.trim(),
              educationLevel: level,
              year: year.trim(),
              school: school.trim(),
              course: course.trim(),
              contentLanguage: t("onboarding.contentLanguage"),
              crashReports,
            },
      );
      await client.invalidateQueries({ queryKey: ["profile"] });
      navigate("/exams");
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const next = () =>
    setStep((value) => Math.min(value + 1, stepIds.length - 1));
  const back = () => setStep((value) => Math.max(value - 1, 0));

  return (
    <div className="px-onboarding">
      <Steps
        size="small"
        current={step}
        items={stepIds.map((item) => ({
          title: t(`onboarding.steps.${item}`),
        }))}
      />
      <p className="meta px-onboarding-count">
        {t("onboarding.stepCount", {
          current: step + 1,
          total: stepIds.length,
        })}
      </p>
      <h1 className="display" tabIndex={-1} ref={heading}>
        {t(id === "profile" ? "onboarding.title" : `onboarding.${id}.title`)}
      </h1>
      <p className="body">
        {t(id === "profile" ? "onboarding.body" : `onboarding.${id}.body`)}
      </p>

      {id === "profile" ? (
        <ProfileStep
          values={{ name, level, year, school, course }}
          set={{ setName, setLevel, setYear, setSchool, setCourse }}
        />
      ) : null}
      {id === "engines" ? <EnginesStep onReady={setEnginesReady} /> : null}
      {id === "photos" ? <PhotosStep onNext={next} /> : null}
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
      <div className="px-onboarding-actions">
        {id === "profile" ? (
          <Button
            type="text"
            shape="round"
            disabled={busy}
            onClick={() => void finish(true)}
          >
            {t("onboarding.skip")}
          </Button>
        ) : (
          <Button type="text" shape="round" disabled={busy} onClick={back}>
            {t("nav.back")}
          </Button>
        )}
        {id === "photos" ? <span /> : null}
        {id === "profile" ? (
          <Button type="primary" shape="round" onClick={next}>
            {t("onboarding.continue")}
          </Button>
        ) : null}
        {id === "engines" ? (
          <Button type="primary" shape="round" onClick={next}>
            {t(
              enginesReady === false
                ? "onboarding.later"
                : "onboarding.continue",
            )}
          </Button>
        ) : null}
        {id === "privacy" ? (
          <Button
            type="primary"
            shape="round"
            loading={busy}
            onClick={() => void finish(false)}
          >
            {t("onboarding.done")}
          </Button>
        ) : null}
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
            value={values.course}
            onChange={(event) => set.setCourse(event.target.value)}
          />
        </div>
      </div>
    </>
  );
}

/**
 * The same one-time OCR language download as Settings > Data, with its own consent text, progress and retry. Pressing
 * "Later" moves on without downloading; a running download keeps going if the student continues.
 */
function PhotosStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  const { data: jobs = [] } = useJobs();
  const downloading = jobs.some(
    (job) =>
      job.kind === "ocr-data-download" &&
      (job.state === "queued" || job.state === "running"),
  );
  const continueButton = (
    <Button type="primary" shape="round" onClick={onNext}>
      {t("onboarding.continue")}
    </Button>
  );
  return (
    <div className="px-onboarding-photos">
      <OcrDataCard
        onLater={onNext}
        laterLabel={t("onboarding.photos.later")}
        readyAction={continueButton}
      />
      {downloading ? (
        <>
          <p className="small px-onboarding-note">
            {t("onboarding.photos.keepGoing")}
          </p>
          <div className="px-onboarding-inline">{continueButton}</div>
        </>
      ) : null}
    </div>
  );
}
