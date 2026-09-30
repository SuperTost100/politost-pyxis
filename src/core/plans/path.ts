export const stages = [
  "intro",
  "diagnostic",
  "learn",
  "practice",
  "cards",
  "gaps",
  "simulation",
  "final",
] as const;

export type Stage = (typeof stages)[number];
export type NodeState = "locked" | "current" | "done";

export type PathNode = {
  id: string;
  stage: Stage;
  topicId: string | null;
  position: number;
};

const middle = 0.5;

const weights = {
  due: 3,
  gap: 4,
  deficit: 2,
  idle: 1,
  style: 1,
};

export function pathState(
  nodes: PathNode[],
  doneIds: string[],
  mastery: Record<string, number>,
  target = 0.8,
): Array<{ id: string; state: NodeState; reason: string }> {
  const done = new Set(doneIds);
  const ordered = [...nodes].sort((a, b) => a.position - b.position);
  const topicOrder = ordered
    .filter((node) => node.stage === "learn" && node.topicId)
    .map((node) => node.topicId as string);
  let currentAssigned = false;
  return ordered.map((node) => {
    if (done.has(node.id)) return { id: node.id, state: "done" as const, reason: "" };
    const reason = lockReason(node, ordered, done, mastery, topicOrder, target);
    if (reason) return { id: node.id, state: "locked" as const, reason };
    if (!currentAssigned) {
      currentAssigned = true;
      return { id: node.id, state: "current" as const, reason: "" };
    }
    return { id: node.id, state: "locked" as const, reason: "plans.unlocksAfterCurrent" };
  });
}

function lockReason(
  node: PathNode,
  nodes: PathNode[],
  done: Set<string>,
  mastery: Record<string, number>,
  topicOrder: string[],
  target: number,
): string {
  const finished = (stage: Stage, topicId?: string | null) =>
    nodes.some(
      (item) =>
        item.stage === stage &&
        (topicId == null || item.topicId === topicId) &&
        done.has(item.id),
    );
  if (node.stage === "intro") return "";
  if (node.stage === "diagnostic") return finished("intro") ? "" : "plans.unlocksAfterIntro";
  if (node.stage === "learn" && node.topicId) {
    if (!finished("diagnostic")) return "plans.unlocksAfterDiagnostic";
    const index = topicOrder.indexOf(node.topicId);
    const previous = index > 0 ? topicOrder[index - 1] : null;
    if (previous && (mastery[previous] ?? 0) < middle) return "plans.unlocksAtHalf";
    return "";
  }
  if (node.stage === "practice" && node.topicId) {
    const learn = nodes.find((item) => item.stage === "learn" && item.topicId === node.topicId);
    if (learn && node.position < learn.position) {
      if (!finished("diagnostic")) return "plans.unlocksAfterDiagnostic";
      const index = topicOrder.indexOf(node.topicId);
      const previous = index > 0 ? topicOrder[index - 1] : null;
      if (previous && (mastery[previous] ?? 0) < middle) return "plans.unlocksAtHalf";
      return "";
    }
  }
  if ((node.stage === "practice" || node.stage === "cards" || node.stage === "gaps") && node.topicId) {
    const level = mastery[node.topicId] ?? 0;
    return level >= middle ? "" : "plans.unlocksAtHalf";
  }
  const levels = topicOrder.map((id) => mastery[id] ?? 0);
  const weakest = levels.length === 0 ? 0 : Math.min(...levels);
  if (node.stage === "simulation") return weakest >= middle ? "" : "plans.unlocksAtHalf";
  return weakest >= target ? "" : "plans.unlocksAtTarget";
}

export function recommend(input: {
  dueCards: number;
  severeGaps: number;
  topicMastery: number;
  target: number;
  daysToExam: number;
  daysIdle: number;
  styleMatch: number;
}): { score: number; reason: string } {
  const urgency = 1 + 2 / Math.max(input.daysToExam, 1);
  const deficit = Math.max(0, input.target - input.topicMastery);
  const score =
    weights.due * input.dueCards +
    weights.gap * input.severeGaps +
    weights.deficit * deficit * urgency +
    weights.idle * input.daysIdle +
    weights.style * input.styleMatch;
  const reason =
    input.dueCards > 0
      ? `${input.dueCards} cards due`
      : input.severeGaps > 0
        ? `${input.severeGaps} severe gaps`
        : "next lesson";
  return { score, reason };
}
