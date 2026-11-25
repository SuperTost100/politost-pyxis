import { describe, expect, it } from "vitest";
import { parseChart } from "../../../shared/chat-blocks";
import { chartDomain, chartRows, chartTick } from "./chartScale";

const chart = (value: object) => parseChart(JSON.stringify({ title: "T", kind: "bar", ...value }))!;

describe("chart scale", () => {
  it("runs a grade chart from zero to the chart's own maximum", () => {
    const grades = chart({ max: 30, series: [{ name: "Voto", points: [{ label: "A", value: 26 }, { label: "B", value: null }] }] });
    expect(chartDomain(grades)).toMatchObject({ lo: 0, hi: 30 });
  });

  it("starts bars at zero and fits a line to its values, the reference line inside both", () => {
    const points = [{ label: "1", value: 22 }, { label: "2", value: 26 }];
    expect(chartDomain(chart({ series: [{ name: "x", points }] }))).toEqual({ lo: 0, hi: 30, ticks: [0, 10, 20, 30] });
    const line = chartDomain(chart({ kind: "line", series: [{ name: "x", points }], reference: { value: 18, label: "18" } }));
    expect(line.lo).toBeLessThanOrEqual(18);
    expect(line.hi).toBeGreaterThanOrEqual(26);
    expect(line.lo).toBeGreaterThan(0);
  });

  it("handles one value, negatives and nothing but missing values", () => {
    expect(chartDomain(chart({ kind: "line", series: [{ name: "x", points: [{ label: "a", value: 5 }] }] }))).toMatchObject({ lo: 0 });
    const negative = chartDomain(chart({ series: [{ name: "x", points: [{ label: "a", value: -4 }, { label: "b", value: 6 }] }] }));
    expect(negative.lo).toBeLessThanOrEqual(-4);
    expect(negative.ticks).toContain(0);
    expect(chartDomain(chart({ series: [{ name: "x", points: [{ label: "a", value: null }] }] }))).toMatchObject({ lo: 0, hi: 1 });
  });

  it("lines up the series by category, in the order categories first appear", () => {
    const rows = chartRows(
      chart({
        series: [
          { name: "a", points: [{ label: "x", value: 1 }, { label: "y", value: 2 }] },
          { name: "b", points: [{ label: "z", value: 3 }, { label: "x", value: 4 }] },
        ],
      }),
    );
    expect(rows.map((row) => [row.label, row.points.map((point) => point?.value ?? "-")])).toEqual([
      ["x", [1, 4]],
      ["y", [2, "-"]],
      ["z", ["-", 3]],
    ]);
  });
});

describe("chart bounds from the block", () => {
  it("never lets min or max cut off a value, the reference line or the bars' zero", () => {
    const bars = chartDomain(chart({ min: 10, series: [{ name: "x", points: [{ label: "a", value: 5 }, { label: "b", value: 10 }] }] }));
    expect(bars.lo).toBeLessThanOrEqual(0);
    expect(bars.hi).toBeGreaterThanOrEqual(10);
    const line = chartDomain(
      chart({ kind: "line", min: 18, max: 19, series: [{ name: "x", points: [{ label: "a", value: 30 }, { label: "b", value: 18.5 }] }] }),
    );
    expect(line.lo).toBeLessThanOrEqual(18.5);
    expect(line.hi).toBeGreaterThanOrEqual(30);
    expect(line.ticks.length).toBeGreaterThanOrEqual(2);
    // Bounds that hold every value are kept as written.
    expect(chartDomain(chart({ min: 0, max: 30, series: [{ name: "x", points: [{ label: "a", value: 26 }] }] }))).toMatchObject({ lo: 0, hi: 30 });
  });

  it("writes ticks with the precision their step needs", () => {
    const small = chartDomain(chart({ kind: "line", series: [{ name: "x", points: [{ label: "a", value: 0.0001 }, { label: "b", value: 0.0004 }] }] }));
    expect(new Set(small.ticks.map((tick) => chartTick(tick, small.ticks, "en"))).size).toBe(small.ticks.length);
  });
});

describe("ticks far below one", () => {
  it("tells neighbouring ticks apart in scientific notation", () => {
    const tiny = chartDomain(chart({ kind: "line", series: [{ name: "x", points: [{ label: "a", value: 1e-13 }, { label: "b", value: 4e-13 }] }] }));
    const labels = tiny.ticks.map((tick) => chartTick(tick, tiny.ticks, "en"));
    for (let i = 1; i < labels.length; i++) expect(labels[i], labels.join(" ")).not.toBe(labels[i - 1]);
    // Ordinary ticks keep their look.
    const grades = chartDomain(chart({ min: 0, max: 30, series: [{ name: "x", points: [{ label: "a", value: 26 }] }] }));
    expect(grades.ticks.map((tick) => chartTick(tick, grades.ticks, "it"))).toEqual(["0", "10", "20", "30"]);
  });
});
