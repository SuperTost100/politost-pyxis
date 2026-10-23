// The mark's geometry, shared by the logo and the plan-building animation. Both draw in viewBox "6 10 88 88",
// centred on (50, 54).

/** The three trails: radius, start angle, sweep in degrees, opacity. */
export const TRAILS: [number, number, number, number][] = [
  [16, 200, 230, 0.9],
  [28, 150, 200, 0.7],
  [40, 230, 170, 0.5],
];

export function arc(r: number, st: number, sp: number): string {
  const a0 = (st * Math.PI) / 180;
  const a1 = ((st + sp) * Math.PI) / 180;
  const x0 = 50 + r * Math.cos(a0);
  const y0 = 54 + r * Math.sin(a0);
  const x1 = 50 + r * Math.cos(a1);
  const y1 = 54 + r * Math.sin(a1);
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${sp > 180 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

export function starPath(): string {
  const k = 9 * 0.18;
  const cx = 50;
  const cy = 54;
  return `M${cx},${cy - 9} C${cx + k},${cy - k} ${cx + k},${cy - k} 59,54 C${cx + k},${cy + k} ${cx + k},${cy + k} ${cx},${cy + 9} C${cx - k},${cy + k} ${cx - k},${cy + k} 41,54 C${cx - k},${cy - k} ${cx - k},${cy - k} ${cx},${cy - 9}Z`;
}
