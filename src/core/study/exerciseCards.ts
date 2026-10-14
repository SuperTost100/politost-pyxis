import type Database from "better-sqlite3";

const DONE = "cards.exercise-seeds-retired";

/**
 * Before 0.3.1 a topic's exercises were seeded as cards: the front is the exercise prompt cut at 400
 * characters and the seed key is that same text. That made whole worked solutions into flashcards.
 * This moves them to Removed once per workspace, so the student can still restore them.
 *
 * A card counts only when it has no generation template (a generated card has one and a `gen:` seed key),
 * its seed key is the front the seeding wrote and it equals the prefix of an exercise that has an answer.
 * A hand-made card has no seed key. A card whose front the student edited no longer equals its seed key,
 * so it stays. Reviews stay with the card.
 */
export function retireExerciseCards(db: Database.Database): number {
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(DONE)) return 0;
    const candidates = db
      .prepare(
        `SELECT id, seed_key FROM cards
         WHERE removed = 0 AND prompt_template IS NULL AND grounding = 'sources'
           AND seed_key IS NOT NULL AND seed_key = TRIM(front)`,
      )
      .all() as Array<{ id: string; seed_key: string }>;
    let retired = 0;
    if (candidates.length) {
      const prompts = new Set(
        (
          db
            .prepare(
              "SELECT prompt FROM exercises WHERE answer IS NOT NULL AND answer != ''",
            )
            .all() as Array<{ prompt: string }>
        ).map((row) => row.prompt.slice(0, 400).trim()),
      );
      const remove = db.prepare("UPDATE cards SET removed = 1 WHERE id = ?");
      for (const card of candidates)
        if (prompts.has(card.seed_key)) retired += remove.run(card.id).changes;
    }
    db.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, 'true', ?)",
    ).run(DONE, Date.now());
    return retired;
  })();
}
