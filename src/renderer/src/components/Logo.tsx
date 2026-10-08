import "./Logo.css";

const TRAILS: [number, number, number, number][] = [
  [16, 200, 230, 0.9],
  [28, 150, 200, 0.7],
  [40, 230, 170, 0.5],
];

function arc(r: number, st: number, sp: number): string {
  const a0 = (st * Math.PI) / 180;
  const a1 = ((st + sp) * Math.PI) / 180;
  const x0 = 50 + r * Math.cos(a0);
  const y0 = 54 + r * Math.sin(a0);
  const x1 = 50 + r * Math.cos(a1);
  const y1 = 54 + r * Math.sin(a1);
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${sp > 180 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

function starPath(): string {
  const k = 9 * 0.18;
  const cx = 50;
  const cy = 54;
  return `M${cx},${cy - 9} C${cx + k},${cy - k} ${cx + k},${cy - k} 59,54 C${cx + k},${cy + k} ${cx + k},${cy + k} ${cx},${cy + 9} C${cx - k},${cy + k} ${cx - k},${cy + k} 41,54 C${cx - k},${cy - k} ${cx - k},${cy - k} ${cx},${cy - 9}Z`;
}

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
