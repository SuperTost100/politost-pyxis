import { weeklyCounts } from "./series";

const at = Date.parse("2026-09-06T04:30:00Z");
const grid = weeklyCounts([{ topicId: "a", at, score: 1, kind: "quiz" }], ["a"], at);
const sum = grid.counts.a?.reduce((total, count) => total + count, 0) ?? 0;
if (sum !== 1) {
  console.error(sum);
  process.exit(1);
}
