import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * Saves a lesson on each topic as it was written before lessons came in parts, for another course. A topic with such a
 * lesson stays on the reader that came before parts, which writes the lesson for the student's own profile in one
 * streamed piece, so a spec about that reader or about the path's lesson step keeps covering it. The saved lesson is
 * never shown: its variant is not the student's, and it has the current prompt version, so it is no earlier lesson.
 */
export function seedLessonBeforeParts(db: DatabaseSync, planId: string, topicIds: readonly string[]) {
  const version = /^version: (\S+)$/m.exec(readFileSync(join("resources", "prompts", "lesson.write.md"), "utf8"))![1]!;
  const insert = db.prepare(
    `INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,prompt_template,prompt_version,grounding,created_at)
     VALUES(?,?,?,'lesson',?,'fixture','lesson.write',?,'sources',1)`,
  );
  for (const topicId of topicIds)
    insert.run(
      `before-parts-${topicId}`,
      planId,
      topicId,
      JSON.stringify({
        cacheKey: JSON.stringify({ kind: "lesson", scopeId: topicId, promptVersion: `${version}|another-course`, passageIds: [] }),
        markdown: "Una lezione scritta prima delle parti, per un altro corso.",
        passageIds: [],
      }),
      version,
    );
}
