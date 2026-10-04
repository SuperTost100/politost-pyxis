import "./MasteryBar.css";

export function MasteryBar({
  value,
  target,
  tone = "mastery",
  showValue = true,
  label,
}: {
  value: number;
  target?: number;
  tone?: "mastery" | "primary";
  showValue?: boolean;
  label: string;
}) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      className="px-mbar"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v}
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
            title={
              target != null
                ? `${Math.max(0, Math.min(100, target))}%`
                : undefined
            }
          />
        ) : null}
      </div>
      {showValue ? <span className="px-mbar-value">{v}%</span> : null}
    </div>
  );
}
