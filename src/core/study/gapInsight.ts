import type Database from "better-sqlite3";

export type GapMiss = {
  question: string;
  expected: string;
  explanation: string;
  passageIds: string[];
};

const clip = (value: unknown, max: number): string => {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

/** First sentence of the saved explanation: the shortest statement of what was misunderstood. */
const firstSentence = (value: unknown): string =>
  clip(
    typeof value === "string" ? (/^.+?[.!?](?=\s|$)/s.exec(value.trim())?.[0] ?? value) : "",
    200,
  );

// A gap opens in the same grading step that saves the answers; a few seconds of slack covers the gap between the two timestamps.
const SLACK = 10_000;

/** The most recent wrongly answered questions of a topic since the gap opened, newest first. */
export function gapMisses(
  db: Database.Database,
  planId: string,
  topicId: string,
  openedAt: number,
  limit = 3,
): GapMiss[] {
  const rows = db
    .prepare(
      `SELECT i.topic_id, i.body_json, aa.payload_json FROM attempt_answers aa
       JOIN attempts a ON a.id = aa.attempt_id JOIN items i ON i.id = a.item_id
       WHERE a.plan_id = ? AND (i.topic_id = ? OR i.topic_id IS NULL)
         AND i.kind IN ('quiz', 'diagnostic', 'simulation')
         AND a.submitted_at IS NOT NULL AND a.submitted_at >= ?
         AND json_type(aa.payload_json, '$.results') = 'array'
       ORDER BY a.submitted_at DESC LIMIT 8`,
    )
    .all(planId, topicId, openedAt - SLACK) as Array<{
    topic_id: string | null;
    body_json: string;
    payload_json: string;
  }>;
  const seen = new Set<string>();
  const misses: GapMiss[] = [];
  for (const row of rows) {
    const body = JSON.parse(row.body_json) as {
      questions?: Array<{
        id: string;
        stem?: string;
        topicId?: string;
        sourceIds?: string[];
      }>;
    };
    const { results = [] } = JSON.parse(row.payload_json) as {
      results?: Array<{ id: string; score: number; expected?: string; explanation?: string }>;
    };
    for (const result of results) {
      const question = body.questions?.find((item) => item.id === result.id);
      if (!question?.stem || result.score >= 1) continue;
      // Mixed items (diagnostic, simulation) only count for the topic each question belongs to.
      if (row.topic_id == null && question.topicId !== topicId) continue;
      const stem = clip(question.stem, 160);
      if (seen.has(stem)) continue;
      seen.add(stem);
      misses.push({
        question: stem,
        expected: clip(result.expected, 160),
        explanation: firstSentence(result.explanation),
        passageIds: question.sourceIds ?? [],
      });
      if (misses.length >= limit) return misses;
    }
  }
  return misses;
}
