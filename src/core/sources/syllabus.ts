import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Runner } from "../jobs/runner";
import { embedTexts, embeddingConsent, embeddingReady } from "./embed";

/**
 * SRC-08: a section whose mean passage vector sits below this cosine similarity to every plan text (title, subject,
 * topics) is called off the syllabus.
 * ponytail: a guess, not tuned. A 10-section check with the pinned multilingual-e5-small (2026-10-04, physics plan,
 * `.tmp/src-check/syllabus-sample.mjs`) gave related text 0.78-0.87 and off-topic English (sport, marketing) 0.75-0.76,
 * but off-topic Italian (cooking 0.84, Roman history 0.81) landed inside the related range, so it is not caught. Treat a
 * warning as likely off-topic and a clean result as "nothing flagged". Tune on real sources before relying on it.
 */
export const OFF_SYLLABUS_BELOW = 0.76;
/** Sections listed to the student, least related first. The rest are only counted. */
const LISTED = 8;

export type SyllabusCheck = {
  planId: string;
  planTitle: string;
  /**
   * `unavailable`: the local search model is off or not downloaded. `unindexed`: the source has no vectors yet.
   * `no-context`: the plan has nothing to compare with. `checked`: the numbers below are valid.
   */
  state: "checked" | "unavailable" | "unindexed" | "no-context";
  /** Sections compared. */
  sections: number;
  /** Sections that are off the syllabus. */
  off: number;
  /** The least related sections, with their best similarity to the plan. */
  worst: Array<{ section: string; similarity: number }>;
};

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    na += a[index]! * a[index]!;
    nb += b[index]! * b[index]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** The mean passage vector of each section of the source's current version, from the vectors already stored. */
export function sectionVectors(
  db: Database.Database,
  sourceId: string,
): Map<string, Float32Array> {
  const sums = new Map<string, { sum: Float32Array; count: number }>();
  const rows = db
    .prepare(
      `SELECT p.section_path AS section, v.embedding AS embedding
       FROM passages p JOIN passages_vec v ON v.passage_rowid = p.rowid
       WHERE p.source_id = ?
         AND p.document_id = (SELECT id FROM source_documents WHERE source_id = p.source_id ORDER BY version DESC LIMIT 1)`,
    )
    .iterate(sourceId) as IterableIterator<{ section: string | null; embedding: Buffer }>;
  for (const row of rows) {
    const vector = new Float32Array(
      row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength),
    );
    const key = row.section ?? "";
    const entry = sums.get(key) ?? { sum: new Float32Array(vector.length), count: 0 };
    for (let index = 0; index < vector.length; index += 1) entry.sum[index]! += vector[index]!;
    entry.count += 1;
    sums.set(key, entry);
  }
  return new Map([...sums].map(([key, entry]) => [key, entry.sum.map((n) => n / entry.count)]));
}

/** What a plan is about: its title, its subject, and its topics that are still in the path. */
export function planContextTexts(db: Database.Database, planId: string): string[] {
  const plan = db
    .prepare(
      `SELECT p.title, s.name AS subject FROM plans p LEFT JOIN subjects s ON s.id = p.subject_id WHERE p.id = ?`,
    )
    .get(planId) as { title: string; subject: string | null } | undefined;
  if (!plan) return [];
  const topics = db
    .prepare(`SELECT title FROM topics WHERE plan_id = ? AND archived_at IS NULL ORDER BY position`)
    .all(planId) as Array<{ title: string }>;
  return [plan.title, plan.subject ?? "", ...topics.map((topic) => topic.title)]
    .map((text) => text.trim())
    .filter(Boolean);
}

/** Pure part of the check: which sections are far from every plan vector. */
export function offSyllabus(
  sections: Map<string, Float32Array>,
  plan: Float32Array[],
  below = OFF_SYLLABUS_BELOW,
): Pick<SyllabusCheck, "sections" | "off" | "worst"> {
  const scored = [...sections].map(([section, vector]) => ({
    section,
    similarity: Math.max(...plan.map((target) => cosine(vector, target))),
  }));
  const off = scored.filter((entry) => entry.similarity < below).sort((a, b) => a.similarity - b.similarity);
  return {
    sections: scored.length,
    off: off.length,
    worst: off.slice(0, LISTED).map((entry) => ({ ...entry, similarity: Math.round(entry.similarity * 1000) / 1000 })),
  };
}

/**
 * Compares a source's sections with each plan that uses it. It reads vectors the index already holds and embeds only
 * the short plan texts with the local model, so no engine request and no cost. It stores nothing; `syllabusFor` keeps
 * the result.
 */
export async function checkSyllabus(
  db: Database.Database,
  modelDir: string,
  sourceId: string,
  signal?: AbortSignal,
  embed: typeof embedTexts = embedTexts,
): Promise<SyllabusCheck[]> {
  const plans = db
    .prepare(
      `SELECT p.id, p.title FROM plans p JOIN plan_sources ps ON ps.plan_id = p.id
       WHERE ps.source_id = ? ORDER BY p.created_at`,
    )
    .all(sourceId) as Array<{ id: string; title: string }>;
  if (plans.length === 0) return [];
  const empty = { sections: 0, off: 0, worst: [] };
  const ready = embeddingConsent(db) && embeddingReady(modelDir);
  const sections = ready ? sectionVectors(db, sourceId) : new Map<string, Float32Array>();
  const out: SyllabusCheck[] = [];
  for (const plan of plans) {
    signal?.throwIfAborted();
    const base = { planId: plan.id, planTitle: plan.title };
    const texts = planContextTexts(db, plan.id);
    if (!ready) out.push({ ...base, state: "unavailable", ...empty });
    else if (sections.size === 0) out.push({ ...base, state: "unindexed", ...empty });
    else if (texts.length === 0) out.push({ ...base, state: "no-context", ...empty });
    else {
      const vectors = await embed(modelDir, texts.map((text) => `query: ${text}`), signal);
      out.push({ ...base, state: "checked", ...offSyllabus(sections, vectors) });
    }
  }
  return out;
}

const storeKey = (sourceId: string) => `syllabus.${sourceId}`;

/**
 * What the stored comparison depends on: the source's current version, and each plan that uses it with the texts it is
 * compared against. A change in either makes the stored result stale. The embedding model is pinned, so it is not part
 * of the key.
 */
function fingerprint(db: Database.Database, sourceId: string): string {
  const version = (
    db.prepare(`SELECT MAX(version) AS v FROM source_documents WHERE source_id = ?`).get(sourceId) as { v: number | null }
  ).v;
  const plans = db
    .prepare(`SELECT ps.plan_id AS id FROM plan_sources ps WHERE ps.source_id = ? ORDER BY ps.plan_id`)
    .all(sourceId) as Array<{ id: string }>;
  return createHash("sha256")
    .update(JSON.stringify([version, plans.map((plan) => [plan.id, planContextTexts(db, plan.id)])]))
    .digest("hex");
}

/**
 * The stored comparison when it is still current, else null. It never embeds or recomputes, so a list of sources can
 * ask for every row.
 */
export function storedSyllabus(db: Database.Database, sourceId: string): SyllabusCheck[] | null {
  const row = db.prepare(`SELECT value_json FROM settings WHERE key = ?`).get(storeKey(sourceId)) as
    | { value_json: string }
    | undefined;
  if (!row) return null;
  const stored = JSON.parse(row.value_json) as { key: string; checks: SyllabusCheck[] };
  return stored.key === fingerprint(db, sourceId) ? stored.checks : null;
}

/**
 * The comparison for a source, from the settings table when it is still current, else recomputed and stored. Only a
 * result where every plan was compared (`checked`) is stored: "unavailable" and "unindexed" describe the app, not the
 * material, and are recomputed each time. Runs after indexing in the import and index jobs, and on view for a plan
 * whose title, subject, topics or sources changed since.
 */
export async function syllabusFor(
  db: Database.Database,
  modelDir: string,
  sourceId: string,
  signal?: AbortSignal,
  embed: typeof embedTexts = embedTexts,
): Promise<SyllabusCheck[]> {
  const key = fingerprint(db, sourceId);
  const row = db.prepare(`SELECT value_json FROM settings WHERE key = ?`).get(storeKey(sourceId)) as
    | { value_json: string }
    | undefined;
  if (row) {
    const stored = JSON.parse(row.value_json) as { key: string; checks: SyllabusCheck[] };
    if (stored.key === key) return stored.checks;
  }
  const checks = await checkSyllabus(db, modelDir, sourceId, signal, embed);
  signal?.throwIfAborted();
  const keep = checks.length > 0 && checks.every((check) => check.state === "checked");
  if (keep)
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(storeKey(sourceId), JSON.stringify({ key, checks }), Date.now());
  else if (row) db.prepare(`DELETE FROM settings WHERE key = ?`).run(storeKey(sourceId));
  return checks;
}

/**
 * The job step: compare a freshly indexed source with its plans and keep the result. A failed comparison must not fail
 * the import, since the check is advice and runs again on view, so only a cancellation is rethrown.
 */
export async function compareToPlans(
  db: Database.Database,
  modelDir: string,
  sourceId: string,
  signal: AbortSignal,
  embed: typeof embedTexts = embedTexts,
): Promise<void> {
  try {
    await syllabusFor(db, modelDir, sourceId, signal, embed);
  } catch (error) {
    if (signal.aborted) throw error;
  }
}

/**
 * SRC-08 after the plan changed. Importing a source usually comes before the plan that uses it, so the comparison made at
 * import had no plan to compare with and stored nothing. Plan creation, a rebuild, and a change of title, subject, topics
 * or sources alter what the stored result depends on, so this queues the existing local `source-index` job (a no-op for
 * vectors already stored, then the comparison) once for each source of the plan that has no current stored result and no
 * queued run. It needs no engine, and it does nothing while the local search model is off. The library list only reads
 * what the job stored, so no list request embeds anything. Returns how many jobs it queued.
 */
export function queueSyllabusChecks(db: Database.Database, runner: Runner, planId: string): number {
  if (!embeddingConsent(db)) return 0;
  const sources = db.prepare(`SELECT source_id AS id FROM plan_sources WHERE plan_id = ?`).all(planId) as Array<{ id: string }>;
  const queued = db.prepare(
    `SELECT 1 FROM jobs WHERE kind = 'source-index' AND state = 'queued' AND json_extract(params_json, '$.sourceId') = ?`,
  );
  let count = 0;
  for (const { id } of sources) {
    if (storedSyllabus(db, id) || queued.get(id)) continue;
    try {
      runner.start("source-index", { sourceId: id });
      count += 1;
    } catch {
      // The check is advice: a runner without the job registered must never fail the plan edit that asked for it.
    }
  }
  return count;
}
