import type Database from "better-sqlite3";
import { foldText } from "../../shared/fold-text";
import { uuidv7 } from "../../shared/ids";
import { addTopicNodes, orderPath } from "./rebuild";

/** Topics a path may hold after an edit by hand, as many as the guided flow lets a new exam start with. */
export const PATH_TOPICS_MAX = 40;
/** Characters of a topic's title, as the guided flow's limit. */
export const TOPIC_TITLE_MAX = 160;

/** A topic of the new list: one the path has, by its id, one this plan archived, by its id, or a new one by its title. */
export type TopicSlot = { id: string } | { restore: string } | { title: string };

const folded = (title: string) => foldText(title).replace(/\s+/g, " ").trim();

/**
 * The path's topics changed by hand: `order` is the new list of the path's topics. A topic the path has keeps its id, its
 * lessons, cards, gaps and grades, and only moves. One this plan archived comes back by its id. A topic left out is archived, as a rebuild archives a topic its
 * sources no longer hold: nothing of it is deleted, and the steps done on it stay in the path's history. A new title
 * that names a topic this plan archived brings that topic back with all it had; any other new title is a new topic
 * without material (grounding `general`), whose lesson is written from the model's own knowledge, as in an exam built
 * without sources. The path's steps follow the new order (`orderPath`). Returns what changed.
 *
 * It writes only `topics` (position, archived_at, new rows) and `path_nodes`: no learning event, attempt, review, card
 * or grade is read or written.
 */
export function editPlanTopics(
  db: Database.Database,
  planId: string,
  order: readonly TopicSlot[],
  now = Date.now(),
): { added: number; restored: number; archived: number } {
  return db.transaction(() => {
    const plan = db.prepare("SELECT status, style FROM plans WHERE id = ?").get(planId) as
      | { status: string; style: string }
      | undefined;
    if (!plan) throw new Error("plan-missing");
    if (plan.status === "building") throw new Error("plan-missing-or-building");
    if (order.length === 0 || order.length > PATH_TOPICS_MAX) throw new Error("topics-count");
    const topics = db
      .prepare("SELECT id, title, archived_at AS archivedAt FROM topics WHERE plan_id = ? ORDER BY position, id")
      .all(planId) as Array<{ id: string; title: string; archivedAt: number | null }>;
    const active = new Set(topics.filter((topic) => topic.archivedAt === null).map((topic) => topic.id));
    const ids: string[] = [];
    const created: Array<{ id: string; title: string }> = [];
    let restored = 0;
    for (const [index, slot] of order.entries()) {
      if ("id" in slot) {
        if (!active.has(slot.id) || ids.includes(slot.id)) throw new Error("topic-missing");
        ids.push(slot.id);
        continue;
      }
      if ("restore" in slot) {
        const topic = topics.find((entry) => entry.id === slot.restore);
        if (!topic || topic.archivedAt === null || ids.includes(topic.id)) throw new Error("topic-missing");
        db.prepare("UPDATE topics SET archived_at = NULL WHERE id = ?").run(topic.id);
        ids.push(topic.id);
        restored += 1;
        continue;
      }
      const title = slot.title.replace(/\s+/g, " ").trim().slice(0, TOPIC_TITLE_MAX);
      if (!title) throw new Error("topic-blank");
      const named = topics.filter((topic) => folded(topic.title) === folded(title));
      if (named.some((topic) => topic.archivedAt === null)) throw new Error("topic-exists");
      // The newest archived topic of that name: the one whose history the student last had in the path.
      const archived = named.filter((topic) => !ids.includes(topic.id)).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))[0];
      if (archived) {
        db.prepare("UPDATE topics SET archived_at = NULL WHERE id = ?").run(archived.id);
        ids.push(archived.id);
        restored += 1;
        continue;
      }
      const id = uuidv7(now + index + 1);
      db.prepare(
        `INSERT INTO topics (id, plan_id, title, position, tree_json, grounding, created_at)
         VALUES (?, ?, ?, ?, ?, 'general', ?)`,
      ).run(id, planId, title, index, JSON.stringify({ summary: "", subtopics: [] }), now);
      ids.push(id);
      created.push({ id, title });
    }
    const leaving = [...active].filter((id) => !ids.includes(id));
    const archive = db.prepare("UPDATE topics SET archived_at = ? WHERE id = ? AND plan_id = ?");
    for (const id of leaving) archive.run(now, id, planId);
    const place = db.prepare("UPDATE topics SET position = ? WHERE id = ?");
    ids.forEach((id, position) => place.run(position, id));
    addTopicNodes(db, planId, plan.style, created, now);
    orderPath(db, planId, ids);
    db.prepare("UPDATE plans SET updated_at = ? WHERE id = ?").run(now, planId);
    return { added: created.length, restored, archived: leaving.length };
  })();
}
