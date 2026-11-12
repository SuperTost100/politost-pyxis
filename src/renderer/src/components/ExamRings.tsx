import { useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";
import { useGradeScale } from "../lib/useGradeScale";
import "./ExamRings.css";

export type RingValues = Pick<
  RequestOutput<"plans.rings">[number],
  "preparation" | "path" | "today" | "todayMinutes" | "todayUnmeasured"
>;

/** Rings with nothing to show yet, while they load. */
export const emptyRings: RingValues = { preparation: null, path: null, today: null, todayMinutes: null, todayUnmeasured: null };

const RADII = [44, 33, 22] as const;
const KEYS = ["preparation", "path", "today"] as const;
type RingKey = (typeof KEYS)[number];

/** A share as a whole percentage, rounded down, so a ring never reads 100% before it is closed. */
function percent(share: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(
    Math.floor(share * 100 + 1e-9) / 100,
  );
}

/**
 * Each ring's value as the student reads it: Preparazione as the grade on their scale, Percorso as a percentage, Oggi
 * as minutes done of its target, and a few words when there is nothing to show.
 */
export function useRingText(values: RingValues | undefined) {
  const { t, i18n } = useTranslation();
  const grade = useGradeScale();
  const text: Record<RingKey, string> = {
    preparation:
      values?.preparation == null ? t("rings.unmeasured") : grade.mastery(values.preparation),
    path: values?.path == null ? t("rings.noPath") : percent(values.path, i18n.language),
    today:
      values?.today != null && values.todayMinutes != null
        ? values.today >= 1
          ? t("rings.todayDone", { done: Math.round(values.todayMinutes.done) })
          : t("rings.todayMinutes", {
              done: Math.round(values.todayMinutes.done),
              target: values.todayMinutes.target,
            })
        : values?.todayUnmeasured === "no-goal"
          ? t("rings.noGoal")
          : values?.todayUnmeasured === "no-date"
            ? t("rings.noDate")
            : values?.todayUnmeasured === "exam-day"
              ? t("rings.examDay")
              : t("rings.nothingToday"),
  };
  return {
    text,
    /** All three in one sentence, for a screen reader and the hover title. */
    label: t("rings.label", text),
  };
}

/**
 * The three exam rings, drawn like activity rings: Preparazione outside, Percorso in the middle, Oggi inside, each
 * filled to its share from the top. An empty value leaves its track bare. `sm` sits in a list row, `lg` heads an exam's
 * page. The drawing is one image whose name carries the three values; nothing animates, since numbers never count up.
 */
export function ExamRings({
  values,
  size = "lg",
  label,
}: {
  values: RingValues;
  size?: "sm" | "lg";
  /** Replaces the default name, for example to put the exam's name first. */
  label?: string;
}) {
  const own = useRingText(values);
  const name = label ?? own.label;
  return (
    <svg className={`px-rings px-rings-${size}`} viewBox="0 0 100 100" role="img" aria-label={name}>
      <title>{name}</title>
      <g transform="rotate(-90 50 50)">
        {KEYS.map((key, index) => {
          const radius = RADII[index]!;
          const length = 2 * Math.PI * radius;
          const share = values[key] ?? 0;
          return (
            <g key={key}>
              <circle className="px-rings-track" cx="50" cy="50" r={radius} />
              {share > 0 ? (
                <circle
                  className={`px-rings-arc is-${key}`}
                  cx="50"
                  cy="50"
                  r={radius}
                  strokeDasharray={`${(length * Math.min(1, share)).toFixed(2)} ${length.toFixed(2)}`}
                />
              ) : null}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/**
 * The legend beside the large rings: each ring's colour, its name and its value, with what it means on hover. Without a
 * study goal, Oggi measures nothing and its value is the way to set one (`onSetGoal`).
 */
export function RingLegend({ values, onSetGoal }: { values: RingValues; onSetGoal?: () => void }) {
  const { t } = useTranslation();
  const { text } = useRingText(values);
  const setGoal = values.todayUnmeasured === "no-goal" && onSetGoal != null;
  return (
    <ul className="px-rings-legend" aria-label={t("rings.legend")}>
      {KEYS.map((key) => (
        <li key={key} title={t(key === "today" && setGoal ? "rings.hint.todayNoGoal" : `rings.hint.${key}`)}>
          <i className={`px-rings-key is-${key}`} aria-hidden />
          <span>{t(`rings.${key}`)}</span>
          {key === "today" && setGoal ? (
            <span className="px-rings-value is-action">
              <span className="visually-hidden">{text.today}. </span>
              <button type="button" className="px-rings-action" onClick={onSetGoal}>
                {t("rings.setGoal")}
              </button>
            </span>
          ) : (
            <span className={values[key] == null ? "px-rings-value is-empty" : "px-rings-value"}>{text[key]}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
