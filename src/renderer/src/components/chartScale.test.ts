import { describe, expect, it } from "vitest";
import { parseChart } from "../../../shared/chat-blocks";
import { chartDomain, chartRows } from "./chartScale";

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
