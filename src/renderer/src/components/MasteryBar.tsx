import { useTranslation } from "react-i18next";
import { formatGrade, type GradeScale } from "../lib/grade";
import "./MasteryBar.css";

/**
 * A bar from 0 to 100 with an optional target mark. `value` and `target` are percentages of the bar. With `scale` they
 * are grades, and the text shows them on that scale ("22,5/30"); without it, as a percentage.
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
  const text = (percent: number) =>
    scale
      ? formatGrade(Math.max(0, Math.min(100, percent)) / 100, scale, i18n.language)
      : `${Math.round(Math.max(0, Math.min(100, percent)))}%`;
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
            title={text(target)}
          />
        ) : null}
      </div>
      {showValue ? <span className="px-mbar-value">{text(value)}</span> : null}
    </div>
  );
}
