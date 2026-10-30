import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  formatGrade,
  formatGradeDelta,
  formatGradeNumber,
  formatGradeWhole,
  gradeScaleOf,
  gradeValue,
  gradeWhole,
  scaledMastery,
} from "./grade";
import { profileQuery } from "./queries";

/** The profile's scale with formatters in the interface language. */
export function useGradeScale() {
  const { i18n } = useTranslation();
  const profile = useQuery(profileQuery);
  const scale = gradeScaleOf(profile.data);
  const locale = i18n.language;
  return {
    scale,
    /** A grade on the scale, one decimal, for bars and charts. */
    value: (fraction: number) => gradeValue(fraction, scale),
    /** Mastery's exact position on the scale, for chart coordinates; the text shows it with `mastery`. */
    masteryPoint: (fraction: number) => scaledMastery(fraction, scale),
    /** Mastery as a whole number alone: "22". Mastery and preparation are never shown with a decimal. */
    masteryNumber: (fraction: number) => formatGradeNumber(gradeWhole(fraction, scale), locale),
    /** Mastery with its scale, whole: "22/30". */
    mastery: (fraction: number) => formatGradeWhole(fraction, scale),
    /** A grade alone, formatted: "22,5". */
    number: (fraction: number) => formatGradeNumber(gradeValue(fraction, scale), locale),
    /** A grade with its scale, one decimal out of 30: "22,5/30". */
    format: (fraction: number) => formatGrade(fraction, scale, locale),
    /** A signed change in points: "+1,5". */
    delta: (change: number) => formatGradeDelta(change, scale, locale),
  };
}

export type GradeFormat = ReturnType<typeof useGradeScale>;
