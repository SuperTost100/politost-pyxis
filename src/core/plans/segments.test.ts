import { describe, expect, it } from "vitest";
import {
  buildSegments,
  passagesByTopic,
  SEGMENT_LIMIT,
  type SegmentRow,
} from "./segments";

const rows = (
  source: string,
  count: number,
  section: (i: number) => string | null,
): SegmentRow[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${source}-${i}`,
    source_id: source,
    text: `Text ${i}`,
    section_path: section(i),
  }));

describe("bounded source segments", () => {
  it("folds a 600-page PDF into a bounded outline that still covers every page once", () => {
    const segments = buildSegments(rows("pdf", 600, (i) => `p. ${i + 1}`));
    expect(segments).toHaveLength(SEGMENT_LIMIT);
    expect(segments.every((segment) => segment.packed)).toBe(true);
    expect(segments[0]).toMatchObject({ id: "s1", label: "p. 1 to p. 5" });
    expect(segments.flatMap((s) => s.passageIds)).toEqual(
      Array.from({ length: 600 }, (_, i) => `pdf-${i}`),
    );
  });

  it("keeps one segment per section when the outline is small", () => {
    const segments = buildSegments(
      rows("doc", 6, (i) => (i < 3 ? "Kinematics" : "Dynamics")),
    );
    expect(
      segments.map((s) => [s.label, s.passageIds.length, s.packed]),
    ).toEqual([
      ["Kinematics", 3, false],
      ["Dynamics", 3, false],
    ]);
  });

  it("splits a flat DOCX or pasted text by passage order instead of one section called text", () => {
    const segments = buildSegments(rows("docx", 100, () => "text"));
    // Five passages per part, so 20 parts: never more than 24.
    expect(segments).toHaveLength(20);
    expect(segments[0]!.label).toBe("text 1/20");
    expect(segments.flatMap((s) => s.passageIds)).toHaveLength(100);
    // A single passage cannot be split further.
    expect(buildSegments(rows("one", 1, () => "text"))).toHaveLength(1);
  });

  it("shares the segment budget between sources", () => {
    const segments = buildSegments([
      ...rows("a", 400, (i) => `a${i}`),
      ...rows("b", 400, (i) => `b${i}`),
    ]);
    expect(segments.length).toBeLessThanOrEqual(SEGMENT_LIMIT);
    expect(
      segments.filter((s) => s.sourceId === "a").length,
    ).toBeLessThanOrEqual(SEGMENT_LIMIT / 2);
    expect(segments.flatMap((s) => s.passageIds)).toHaveLength(800);
  });

  it("attaches segments no topic named to the nearest earlier topic of the same source", () => {
    const segments = buildSegments([
      ...rows("a", 4, (i) => `a${i}`),
      ...rows("b", 2, (i) => `b${i}`),
    ]);
    // s1..s4 belong to a, s5..s6 to b.
    const byTopic = passagesByTopic(segments, [["s2"], ["s4"], ["s6"]]);
    expect(byTopic[0]).toEqual(["a-0", "a-1", "a-2"]);
    expect(byTopic[1]).toEqual(["a-3"]);
    // s5 comes before the first named segment of b, so it follows the later one.
    expect(byTopic[2]).toEqual(["b-0", "b-1"]);
  });
});
