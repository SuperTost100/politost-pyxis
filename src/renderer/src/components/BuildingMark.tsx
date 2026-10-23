import { useMemo } from "react";
import { arc, starPath, TRAILS } from "./logoMark";
import "./BuildingMark.css";

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
