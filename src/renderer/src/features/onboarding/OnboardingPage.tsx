import { useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";

const levels = [
  "primary",
  "lower-secondary",
  "upper-secondary",
  "technical",
  "vocational",
  "university",
  "other",
] as const;

export function OnboardingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [level, setLevel] = useState<(typeof levels)[number]>("university");
  const [year, setYear] = useState("");
  const [school, setSchool] = useState("");
  const [course, setCourse] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

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
            },
      );
      await client.invalidateQueries({ queryKey: ["profile"] });
      navigate(skip ? "/exams" : "/settings?setup=1");
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ask-home px-onboarding">
      <h1 className="display">{t("onboarding.title")}</h1>
      <p className="body">{t("onboarding.body")}</p>
      <div className="px-form-field">
        <label className="label" htmlFor="profile-name">
          {t("onboarding.name")}
        </label>
        <Input
          id="profile-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="label section-label">{t("onboarding.level")}</div>
      <div className="choice-list px-profile-levels">
        {levels.map((item) => (
          <button
            key={item}
            type="button"
            className={item === level ? "choice is-selected" : "choice"}
            aria-pressed={item === level}
            onClick={() => setLevel(item)}
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
            value={year}
            onChange={(event) => setYear(event.target.value)}
          />
        </div>
        <div className="px-form-field">
          <label className="label" htmlFor="profile-school">
            {t("onboarding.school")}
          </label>
          <Input
            id="profile-school"
            value={school}
            onChange={(event) => setSchool(event.target.value)}
          />
        </div>
        <div className="px-form-field">
          <label className="label" htmlFor="profile-course">
            {t("onboarding.course")}
          </label>
          <Input
            id="profile-course"
            value={course}
            onChange={(event) => setCourse(event.target.value)}
          />
        </div>
      </div>
      {failed && <Notice tone="danger">{t("onboarding.saveFailed")}</Notice>}
      <div className="gallery-row">
        <Button
          type="primary"
          shape="round"
          disabled={busy}
          onClick={() => void finish(false)}
        >
          {t("onboarding.continue")}
        </Button>
        <Button
          type="text"
          shape="round"
          disabled={busy}
          onClick={() => void finish(true)}
        >
          {t("onboarding.skip")}
        </Button>
      </div>
    </div>
  );
}
