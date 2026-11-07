import { Button } from "antd";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { PROFILE_LIMITS } from "@shared/limits";
import {
  ControlGroup,
  ControlList,
  ControlRow,
  Segmented,
  Stepper,
  SwitchRow,
  TagsField,
  TextRow,
} from "../../components/Controls";
import { gradeScaleOf, gradeScales, type GradeScale } from "../../lib/grade";
import type { useProfile } from "../../lib/queries";
import { YEAR_RANGE, yearNumber } from "./profile-year";

export const levels = [
  "primary",
  "lower-secondary",
  "upper-secondary",
  "technical",
  "vocational",
  "university",
  "other",
] as const;

export type ProfilePatch = {
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
  gradeScale?: GradeScale | null;
};

/**
 * Settings > Profile (pyxis-mockups app/index.html, "s-settings-profile"): who the student is, in a head row and in
 * rows with a field on the right; the study level and the grade scale; the interests; and setup again.
 */
export function ProfilePanel({
  profile,
  patch,
}: {
  profile: ReturnType<typeof useProfile>["data"];
  patch: (input: ProfilePatch) => Promise<void>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const ids = { year: useId(), level: useId(), scale: useId(), setup: useId() };
  const level = (profile?.educationLevel ?? "university") as (typeof levels)[number];
  const year = yearNumber(profile?.year);
  const name = profile?.displayName.trim() ?? "";
  // The head says what the student studies and which year: the course, or the school when there is no course.
  const studies = profile?.course.trim() || profile?.school.trim() || t(`onboarding.levels.${level}`);
  const yearText =
    year !== null ? t("settings.who.year", { year }) : (profile?.year.trim() ?? "");
  const interests = profile?.interests ?? [];
  return (
    <div className="px-settings-groups">
      <div className="px-settings-who">
        <span className="px-settings-avatar" aria-hidden="true">
          {(name.at(0) ?? "?").toLocaleUpperCase()}
        </span>
        <div>
          <b>{name || t("settings.who.noName")}</b>
          <span>{[studies, yearText].filter(Boolean).join(" · ")}</span>
        </div>
      </div>

      <ControlGroup title={t("settings.groups.who")}>
        <ControlList>
          {(["displayName", "school", "course"] as const).map((field) => (
            <TextRow
              key={field}
              title={t(field === "displayName" ? "onboarding.name" : `onboarding.${field}`)}
              value={profile?.[field] ?? ""}
              maxLength={PROFILE_LIMITS[field]}
              placeholder={t(`settings.fieldPlaceholder.${field}`)}
              onSave={(value) => void patch({ [field]: value })}
            />
          ))}
          <ControlRow id={ids.year} title={t("onboarding.year")}>
            <Stepper
              label={ids.year}
              value={year}
              min={YEAR_RANGE.min}
              max={YEAR_RANGE.max}
              decreaseLabel={t("settings.fewer")}
              increaseLabel={t("settings.more")}
              disabled={!profile}
              onChange={(value) => void patch({ year: String(value) })}
            />
          </ControlRow>
        </ControlList>
      </ControlGroup>

      <ControlGroup title={t("settings.groups.level")}>
        <ControlList>
          <ControlRow id={ids.level} title={t("settings.level")} description={t("settings.levelHelp")}>
            <select
              className="px-ctl-field"
              aria-labelledby={ids.level}
              aria-describedby={`${ids.level}-description`}
              value={level}
              disabled={!profile}
              // The level brings back its own scale, as core does when it saves a new level; saying so here shows it at once.
              onChange={(event) =>
                void patch({ educationLevel: event.target.value as (typeof levels)[number], gradeScale: null })
              }
            >
              {levels.map((item) => (
                <option key={item} value={item}>
                  {t(`onboarding.levels.${item}`)}
                </option>
              ))}
            </select>
          </ControlRow>
          <ControlRow id={ids.scale} title={t("settings.gradeScale")} description={t("settings.gradeScaleHelp")}>
            <Segmented
              label={ids.scale}
              value={String(gradeScaleOf(profile))}
              options={gradeScales.map((scale) => ({
                value: String(scale),
                label: t("settings.gradeScaleOn", { scale }),
              }))}
              onChange={(value) => void patch({ gradeScale: Number(value) as GradeScale })}
            />
          </ControlRow>
        </ControlList>
      </ControlGroup>

      <ControlGroup title={t("settings.interests")} hint={t("settings.interestsHint")}>
        <ControlList>
          <SwitchRow
            title={t("settings.interestsOn")}
            checked={profile?.interestsOn !== false}
            onChange={(interestsOn) => void patch({ interestsOn })}
            below={
              profile?.interestsOn !== false ? (
                <div className="px-ctl-sub">
                  <TagsField
                    label={t("settings.interestsLabel")}
                    values={interests}
                    max={PROFILE_LIMITS.interests}
                    maxLength={PROFILE_LIMITS.interest}
                    placeholder={t("settings.interestsAdd")}
                    fullPlaceholder={t("settings.interestsFull", { max: PROFILE_LIMITS.interests })}
                    removeLabel={(name) => t("settings.interestsRemove", { name })}
                    onChange={(next) => void patch({ interests: next })}
                  />
                </div>
              ) : null
            }
          />
        </ControlList>
      </ControlGroup>

      <ControlGroup>
        <ControlList>
          <ControlRow id={ids.setup} title={t("settings.setupTitle")} description={t("settings.runSetupHint")}>
            <Button size="small" aria-label={t("settings.runSetup")} onClick={() => navigate("/onboarding?again=1")}>
              {t("settings.runSetupShort")}
            </Button>
          </ControlRow>
        </ControlList>
      </ControlGroup>
    </div>
  );
}
