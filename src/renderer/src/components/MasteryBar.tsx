import { useTranslation } from "react-i18next";
import { formatGrade, formatGradeWhole, type GradeScale } from "../lib/grade";
import "./MasteryBar.css";

/**
 * A bar from 0 to 100 with an optional target mark. `value` and `target` are percentages of the bar. With `scale` the
 * value is a mastery on that scale, always a whole number rounded down ("22/30") so a topic never looks at its goal
 * before it is; without it, a percentage. The goal mark keeps its decimals.
 */
export function MasteryBar({
  value,
  target,
  tone = "mastery",
  showValue = true,
  label,
  scale,
}: {
  value: number;
  target?: number;
  tone?: "mastery" | "primary";
  showValue?: boolean;
  label: string;
  scale?: GradeScale;
}) {
  const { i18n } = useTranslation();
  const v = Math.round(Math.max(0, Math.min(100, value)));
  const text = (percent: number, exact = false) => {
    const fraction = Math.max(0, Math.min(100, percent)) / 100;
    if (!scale) return `${Math.round(fraction * 100)}%`;
    return exact ? formatGrade(fraction, scale, i18n.language) : formatGradeWhole(fraction, scale);
  };
  return (
    <div
      className="px-mbar"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v}
      aria-valuetext={scale ? text(value) : undefined}
      aria-label={label}
    >
      <div className="px-mbar-track">
        <div
          className={["px-mbar-fill", tone === "primary" && "is-primary"]
            .filter(Boolean)
            .join(" ")}
          style={{ width: `${v}%` }}
        />
        {target != null ? (
          <div
            className="px-mbar-target"
            style={{ left: `${Math.max(0, Math.min(100, target))}%` }}
            title={text(target, true)}
          />
        ) : null}
      </div>
      {showValue ? <span className="px-mbar-value">{text(value)}</span> : null}
    </div>
  );
}
