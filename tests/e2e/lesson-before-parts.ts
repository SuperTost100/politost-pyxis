import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type LessonBeforeParts = {
  /** The lesson's text; by default one line that says what it is. */
  markdown?: string;
  /**
   * The student's own lesson at this level, in the variant the reader looks for (the plan's education level, the
   * profile's school and course, the plan's language, the topic's passages), so opening the topic finds it. Without it
   * the lesson is for another course, so a finished topic's reader writes the student's own.
   */
  wording?: "simple" | "balanced" | "technical";
  /** Records the topic's lesson step naming this lesson, as "Fatto" does: the lesson is finished. */
  finished?: boolean;
};

/**
 * Saves a lesson on each topic as it was written before lessons came in parts, with id `before-parts-<topic>`. An
 * unfinished one is rewritten in parts when the topic's lesson is opened; a finished one opens in the reader that came
 * before parts, so a spec about that reader seeds a finished one.
 */
export function seedLessonBeforeParts(
  db: DatabaseSync,
  planId: string,
  topicIds: readonly string[],
  options: LessonBeforeParts = {},
) {
  const version = /^version: (\S+)$/m.exec(readFileSync(join("resources", "prompts", "lesson.write.md"), "utf8"))![1]!;
  const code = (db.prepare("SELECT content_language AS language FROM plans WHERE id = ?").get(planId) as { language: string })
    .language;
  // The key names the language as the prompts do.
  const language = ({ it: "Italian", en: "English" } as Record<string, string>)[code] ?? code;
  // What the reader's cache key holds besides the level: the plan's education level (copied from the profile when the
  // plan was made, or on first use), and the profile's school and course on one line.
  const profile = db.prepare("SELECT education_level AS education, school, course FROM profile LIMIT 1").get() as
    | { education: string | null; school: string | null; course: string | null }
    | undefined;
  const stored = db.prepare("SELECT value_json AS value FROM settings WHERE key = ?").get(`plan-education:${planId}`) as
    | { value: string }
    | undefined;
  const education = (stored ? (JSON.parse(stored.value) as { level?: string }).level : null) ?? profile?.education ?? "university";
  const line = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const insert = db.prepare(
    `INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,prompt_template,prompt_version,grounding,created_at)
     VALUES(?,?,?,'lesson',?,'fixture','lesson.write',?,'sources',1)`,
  );
  for (const topicId of topicIds) {
    const passageIds = (
      db.prepare("SELECT passage_id AS id FROM topic_passages WHERE topic_id = ? ORDER BY passage_id").all(topicId) as Array<{
        id: string;
      }>
    ).map((row) => row.id);
    const variant = options.wording
      ? ["complete-2", options.wording, education, line(profile?.school), line(profile?.course), language].join("|")
      : "another-course";
    const itemId = `before-parts-${topicId}`;
    insert.run(
      itemId,
      planId,
      topicId,
      JSON.stringify({
        cacheKey: JSON.stringify({
          kind: "lesson",
          scopeId: topicId,
          promptVersion: `${version}|${variant}`,
          passageIds: options.wording ? passageIds : [],
        }),
        markdown: options.markdown ?? "Una lezione scritta prima delle parti, per un altro corso.",
        passageIds: options.wording ? passageIds : [],
      }),
      version,
    );
    // The student's own lesson cites its topic's passages, as a written one does.
    if (options.wording)
      for (const passageId of passageIds)
        db.prepare("INSERT INTO item_passages(item_id,passage_id) VALUES(?,?)").run(itemId, passageId);
    if (options.finished)
      db.prepare(
        "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES(?,'lesson_completed',?,?,?,?)",
      ).run(`before-parts-done-${topicId}`, planId, topicId, JSON.stringify({ activity: "lesson", itemId }), Date.now());
  }
}
