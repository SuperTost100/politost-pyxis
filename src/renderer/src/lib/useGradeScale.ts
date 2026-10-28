import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  formatGrade,
  formatGradeDelta,
  formatGradeNumber,
  gradeScaleOf,
  gradeValue,
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
    /** The number on the scale, for bars and charts. */
    value: (fraction: number) => gradeValue(fraction, scale),
    /** The number alone, formatted: "22,5". */
    number: (fraction: number) => formatGradeNumber(gradeValue(fraction, scale), locale),
    /** The number with its scale: "22,5/30". */
    format: (fraction: number) => formatGrade(fraction, scale, locale),
    /** A signed change in points: "+1,5". */
    delta: (change: number) => formatGradeDelta(change, scale, locale),
  };
}

export type GradeFormat = ReturnType<typeof useGradeScale>;
