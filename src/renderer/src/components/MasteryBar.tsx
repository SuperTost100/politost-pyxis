import { useTranslation } from "react-i18next";
import { formatGrade, formatGradeWhole, type GradeScale } from "../lib/grade";
import "./MasteryBar.css";

/**
 * A bar from 0 to 100 with an optional target mark. `value` and `target` are percentages of the bar. With `scale` they
 * are grades, and the text shows them on that scale ("22,5/30"); without it, as a percentage. `whole` rounds the value
 * down to a whole mark ("22/30"), as the exam path does, so a topic never looks at its goal before it is. The goal mark
 * keeps its decimals.
 */
export function MasteryBar({
  value,
  target,
  tone = "mastery",
  showValue = true,
  label,
  scale,
  whole = false,
}: {
  value: number;
  target?: number;
  tone?: "mastery" | "primary";
  showValue?: boolean;
  label: string;
  scale?: GradeScale;
  whole?: boolean;
}) {
  const { i18n } = useTranslation();
  const v = Math.round(Math.max(0, Math.min(100, value)));
  const text = (percent: number, exact = false) => {
    const fraction = Math.max(0, Math.min(100, percent)) / 100;
    if (!scale) return `${Math.round(fraction * 100)}%`;
    return whole && !exact ? formatGradeWhole(fraction, scale) : formatGrade(fraction, scale, i18n.language);
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
