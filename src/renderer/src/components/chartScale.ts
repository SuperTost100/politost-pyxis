import { chartCategories, type ChartData } from "../../../shared/chat-blocks";

/** A step of 1, 2, 2.5 or 5 times a power of ten that splits `span` into about `count` parts. */
function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
}

/**
 * The value range a chart draws and its axis ticks, one range that holds every value, the reference line and, for bars,
 * the zero they start from. The chart's own `min` and `max` set the ends when they hold all of that (a grade out of 30
 * runs to 30), and are ignored where they would cut something off. Otherwise the ends are widened to round ticks.
 */
export function chartDomain(chart: ChartData): { lo: number; hi: number; ticks: number[] } {
  const values = chart.series.flatMap((series) => series.points.flatMap((point) => (point.value === null ? [] : [point.value])));
  if (chart.reference) values.push(chart.reference.value);
  if (chart.kind === "bar") values.push(0);
  let lo = values.length ? Math.min(...values) : 0;
  let hi = values.length ? Math.max(...values) : 1;
  if (hi === lo) [lo, hi] = lo === 0 ? [0, 1] : [Math.min(0, lo), Math.max(0, hi) || 1];
  const step = niceStep(hi - lo, 4);
  const fromLo = chart.min !== undefined && chart.min <= lo ? chart.min : Math.floor(lo / step + 1e-9) * step;
  const toHi = chart.max !== undefined && chart.max >= hi ? chart.max : Math.ceil(hi / step - 1e-9) * step;
  // The ticks fit the range finally drawn, which bounds from the block may have widened.
  const tickStep = niceStep(toHi - fromLo, 4);
  const ticks: number[] = [];
  for (let tick = Math.ceil(fromLo / tickStep - 1e-9) * tickStep; tick <= toHi + tickStep * 1e-9 && ticks.length < 12; tick += tickStep)
    ticks.push(Math.round(tick / tickStep) * tickStep || 0);
  return { lo: fromLo, hi: toHi, ticks };
}

/** A tick's label with the decimals its step needs, so ticks 0.0001 apart never read the same. */
export function chartTick(tick: number, ticks: readonly number[], locale: string): string {
  const step = ticks.length > 1 ? Math.abs(ticks[1]! - ticks[0]!) : Math.abs(tick) || 1;
  // Far below one, fixed decimals cannot tell neighbouring ticks apart: they are written as 1E-13, 1,5E-13.
  if (step < 1e-6)
    return new Intl.NumberFormat(locale, { notation: "scientific", maximumSignificantDigits: 3 }).format(tick);
  // As many decimals as the step itself has: 0.25 needs two, 2.5 one, 10 none.
  const decimals = (step.toFixed(12).replace(/0+$/, "").split(".")[1] ?? "").length;
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: decimals }).format(tick);
}

/** Each category with the point of every series at it (null where the series has none). */
export function chartRows(chart: ChartData) {
  return chartCategories(chart);
}
