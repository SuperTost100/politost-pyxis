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
  const list = (...ids: string[]) => ({ total: ids.length, gaps: ids.map((id) => gap(id)) });

  it("is not closed while the gap is open, whether or not the exam still lists it", () => {
    expect(gapEnd({ gapId: "g1", merged: false, closed: false }, list("g1", "g2"))).toEqual({ closed: false });
    expect(gapEnd({ gapId: "g1", merged: false, closed: false }, list("g2"))).toEqual({ closed: false });
  });

  it("is closed when the gap says so, with the most serious gap that remains as the next one", () => {
    const next = gap("g2", "Serie");
    expect(gapEnd({ gapId: "g1", merged: false, closed: true }, { total: 1, gaps: [next] })).toEqual({ closed: true, next });
    expect(gapEnd({ gapId: "g1", merged: false, closed: true }, list())).toEqual({ closed: true, next: null });
  });

  it("does not call a gap closed that merged into one that is still open", () => {
    // The merged gap is gone from the list, and the one it merged into is the open one: nothing was closed by learning.
    expect(gapEnd({ gapId: "g2", merged: true, closed: false }, list("g2", "g3"))).toEqual({ closed: false });
  });

  it("does not offer the gap that was just closed as the next one", () => {
    expect(gapEnd({ gapId: "g2", merged: true, closed: true }, list("g2", "g3"))).toEqual({ closed: true, next: gap("g3") });
  });

  it("says nothing is closed when the gap's state could not be found", () => {
    expect(gapEnd(null, list("g2"))).toEqual({ closed: false });
  });
});
