import { useQueryClient } from "@tanstack/react-query";
import { Button } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
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
  const [school, setSchool] = useState("");
  const [course, setCourse] = useState("");
  const [busy, setBusy] = useState(false);

  async function finish(skip: boolean) {
    if (busy) return;
    setBusy(true);
    await invoke("profile.save", skip
      ? { displayName: "" }
      : {
          displayName: name.trim(),
          educationLevel: level,
          school: school.trim(),
          course: course.trim(),
          contentLanguage: t("onboarding.contentLanguage"),
        });
    await client.invalidateQueries({ queryKey: ["profile"] });
    navigate(skip ? "/exams" : "/settings?setup=1");
  }

  return (
    <div className="ask-home">
      <h1 className="display">{t("onboarding.title")}</h1>
      <p className="body">{t("onboarding.body")}</p>
      <label className="label" htmlFor="profile-name">
        {t("onboarding.name")}
      </label>
      <input
        id="profile-name"
        className="engine-key"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="label section-label">{t("onboarding.level")}</div>
      <div className="choice-list">
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
      <label className="label" htmlFor="profile-school">
        {t("onboarding.school")}
      </label>
      <input
        id="profile-school"
        value={school}
        onChange={(event) => setSchool(event.target.value)}
      />
      <label className="label" htmlFor="profile-course">
        {t("onboarding.course")}
      </label>
      <input
        id="profile-course"
        value={course}
        onChange={(event) => setCourse(event.target.value)}
      />
      <div className="gallery-row">
        <Button type="primary" shape="round" disabled={busy} onClick={() => void finish(false)}>
          {t("onboarding.continue")}
        </Button>
        <Button type="text" shape="round" disabled={busy} onClick={() => void finish(true)}>
          {t("onboarding.skip")}
        </Button>
      </div>
    </div>
  );
}
