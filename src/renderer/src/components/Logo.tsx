import { arc, starPath, TRAILS } from "./logoMark";
import "./Logo.css";

/**
 * With `working` the rings turn around the centre, ring 1 clockwise and the next ones alternating.
 * Each ring sits in a group with an invisible full circle so its fill box is centred on the mark.
 */
export function Logo({
  size = 32,
  wordmark,
  inverse,
  working,
}: {
  size?: number;
  wordmark?: boolean;
  inverse?: boolean;
  working?: boolean;
}) {
  const stroke = inverse ? "var(--on-primary)" : "var(--ink)";
  const mark = (
    <svg
      width={size}
      height={size}
      viewBox="6 10 88 88"
      role="img"
      aria-label={wordmark ? undefined : "Pyxis"}
      aria-hidden={wordmark ? true : undefined}
      className={working ? "px-logo-working" : undefined}
      style={{ flex: "none" }}
    >
      {TRAILS.map(([r, st, sp, opacity], i) => (
        <g key={i} className={working ? `px-logo-ring px-logo-ring-${i + 1}` : undefined}>
          {working ? <circle cx={50} cy={54} r={r} fill="none" stroke="none" /> : null}
          <path
            d={arc(r, st, sp)}
            fill="none"
            stroke={stroke}
            strokeWidth={5}
            strokeLinecap="round"
            opacity={opacity}
          />
        </g>
      ))}
      <path d={starPath()} fill="var(--star)" />
    </svg>
  );
  if (!wordmark) return mark;
  return (
    <span className="px-logo" style={{ fontSize: size * 0.8 }}>
      {mark}
      <span>Pyxis</span>
    </span>
  );
}
