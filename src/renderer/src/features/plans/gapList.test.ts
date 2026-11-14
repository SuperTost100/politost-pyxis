import { describe, expect, it } from "vitest";
import type { JobView, RequestOutput } from "../../../../shared/ipc";
import { gapEnd, insightRunning } from "./gapList";

const job = (patch: Partial<JobView>) => ({ id: "j", kind: "gap-insight", state: "running", exam: "Analisi 2", topic: "Limiti", ...patch }) as JobView;
const gap = (gapId: string, topicTitle = "Limiti") =>
  ({ gapId, topicId: `t-${gapId}`, topicTitle, level: "minor", sentence: null, wrongAnswers: 2, openedAt: 1 }) as RequestOutput<"plans.openGaps">["gaps"][number];

describe("insightRunning", () => {
  it("is true while the analysis of this exam's topic is queued or running", () => {
    expect(insightRunning([job({})], "Analisi 2", "Limiti")).toBe(true);
    expect(insightRunning([job({ state: "queued" })], "Analisi 2", "Limiti")).toBe(true);
  });

  it("ignores a finished job, another kind, another topic and another exam", () => {
    expect(insightRunning([job({ state: "succeeded" })], "Analisi 2", "Limiti")).toBe(false);
    expect(insightRunning([job({ kind: "gap-drill" })], "Analisi 2", "Limiti")).toBe(false);
    expect(insightRunning([job({})], "Analisi 2", "Serie")).toBe(false);
    expect(insightRunning([job({})], "Fisica", "Limiti")).toBe(false);
  });
});

describe("gapEnd", () => {
  it("is not closed while the exam still lists the gap", () => {
    expect(gapEnd({ total: 2, gaps: [gap("g1"), gap("g2")] }, "g1")).toEqual({ closed: false });
  });

  it("is closed when the exam no longer lists it, with the most serious gap left as the next one", () => {
    const next = gap("g2", "Serie");
    expect(gapEnd({ total: 1, gaps: [next] }, "g1")).toEqual({ closed: true, next });
    expect(gapEnd({ total: 0, gaps: [] }, "g1")).toEqual({ closed: true, next: null });
  });

  it("does not call a gap closed when the list was cut before it", () => {
    expect(gapEnd({ total: 120, gaps: [gap("g2")] }, "g1")).toEqual({ closed: false });
  });
});
