import { chartCategories, type ChartData } from "../../../shared/chat-blocks";

/** A step of 1, 2, 2.5 or 5 times a power of ten that splits `span` into about `count` parts. */
function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
}

/**
 * The value range a chart draws and its axis ticks. The chart's own `min` and `max` win (a grade out of 30 runs to 30).
 * Bars always include zero, where they start; a line fits its values, widened to round ticks. The reference line is
 * always inside.
 */
export function chartDomain(chart: ChartData): { lo: number; hi: number; ticks: number[] } {
  const values = chart.series.flatMap((series) => series.points.flatMap((point) => (point.value === null ? [] : [point.value])));
  if (chart.reference) values.push(chart.reference.value);
  if (chart.kind === "bar") values.push(0);
  let lo = Math.min(...values, chart.min ?? Infinity);
  let hi = Math.max(...values, chart.max ?? -Infinity);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) [lo, hi] = [0, 1];
  if (hi === lo) [lo, hi] = lo === 0 ? [0, 1] : [Math.min(0, lo), Math.max(0, hi) || 1];
  const step = niceStep(hi - lo, 4);
  const niceLo = chart.min ?? Math.floor(lo / step + 1e-9) * step;
  const niceHi = chart.max ?? Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let tick = Math.ceil(niceLo / step - 1e-9) * step; tick <= niceHi + step * 1e-9 && ticks.length < 12; tick += step)
    ticks.push(Math.round(tick / step) * step || 0);
  return { lo: niceLo, hi: niceHi, ticks };
}

/** Each category with the point of every series at it (null where the series has none). */
export function chartRows(chart: ChartData) {
  return chartCategories(chart);
}
