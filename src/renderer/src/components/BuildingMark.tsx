import { useMemo } from "react";
import "./BuildingMark.css";

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

// ponytail: arc length is approximated from viewBox geometry; upgrade path if dash sync drifts at large sizes
const TRAIL_LENGTH = [72, 118, 168];

export function BuildingMark({
  inner = 0,
  middle = 0,
  outer = 0,
  done,
  failedTrail,
}: {
  inner?: number;
  middle?: number;
  outer?: number;
  done?: boolean;
  failedTrail?: 0 | 1 | 2;
}) {
  const progresses = [inner, middle, outer];
  const paths = useMemo(
    () =>
      TRAILS.map(([r, st, sp, opacity], i) => ({
        d: arc(r, st, sp),
        opacity,
        len: TRAIL_LENGTH[i],
      })),
    [],
  );

  return (
    <svg
      className={["px-building-mark", done && "is-done"].filter(Boolean).join(" ")}
      width={160}
      height={160}
      viewBox="6 10 88 88"
      role="img"
      aria-hidden
    >
      {paths.map((p, i) => {
        const t = Math.max(0, Math.min(1, progresses[i] ?? 0));
        if (t <= 0) return null;
        const failed = failedTrail === i;
        const dash = p.len ?? 100;
        const offset = dash * (1 - t);
        return (
          <path
            key={i}
            d={p.d}
            fill="none"
            stroke={failed ? "var(--ink-subtle)" : "var(--ink)"}
            strokeWidth={5}
            strokeLinecap="round"
            opacity={failed ? 0.5 : p.opacity}
            strokeDasharray={dash}
            strokeDashoffset={offset}
            className="px-building-trail"
          />
        );
      })}
      <path d={starPath()} fill="var(--star)" className="px-building-star" />
    </svg>
  );
}
