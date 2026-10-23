import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/**
 * Seed rows for a workspace database the app has created. Each helper writes only the columns a spec passes, plus the
 * values almost every spec uses (status "ready", timestamps 1), so a column left out keeps the schema's default.
 */

function insert(
  db: DatabaseSync,
  table: string,
  row: Record<string, SQLInputValue | undefined>,
) {
  const columns = Object.keys(row).filter((key) => row[key] !== undefined);
  db.prepare(
    `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
  ).run(...columns.map((key) => row[key]!));
}

/** Subjects on the Exams page. Positions follow the list unless given. */
export function seedSubjects(
  db: DatabaseSync,
  subjects: Array<{ id: string; name: string; position?: number }>,
) {
  subjects.forEach(({ id, name, position }, index) =>
    insert(db, "subjects", {
      id,
      name,
      position: position ?? index,
      created_at: 1,
    }),
  );
}

export type SeedPlan = {
  id: string;
  title: string;
  subjectId?: string;
  status?: string;
  language?: string;
  target?: number;
  examAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  /** Topics in order, positions 0, 1… */
  topics?: Array<{ id: string; title: string }>;
  /** Library sources the plan studies from (plan_sources). */
  sourceIds?: string[];
};

/** A plan with its topics and sources. Status "ready" and timestamps 1 unless given. */
export function seedPlan(db: DatabaseSync, plan: SeedPlan) {
  insert(db, "plans", {
    id: plan.id,
    subject_id: plan.subjectId,
    title: plan.title,
    status: plan.status ?? "ready",
    content_language: plan.language,
    target: plan.target,
    exam_at: plan.examAt,
    created_at: plan.createdAt ?? 1,
    updated_at: plan.updatedAt ?? plan.createdAt ?? 1,
  });
  for (const sourceId of plan.sourceIds ?? [])
    insert(db, "plan_sources", { plan_id: plan.id, source_id: sourceId });
  plan.topics?.forEach((topic, position) =>
    insert(db, "topics", {
      id: topic.id,
      plan_id: plan.id,
      title: topic.title,
      position,
      created_at: 1,
    }),
  );
}

export type SeedSource = {
  id: string;
  title: string;
  /** "excerpt" unless given. */
  kind?: string;
  status?: string;
  /** In the library (1) unless given; null leaves the column out. */
  library?: number | null;
  /** Its read document; tree_json is {"kind": kind} unless given. */
  document?: { id: string; tree?: unknown };
  passages?: Array<{
    id: string;
    text: string;
    locator?: unknown;
    section?: string;
  }>;
};

/** A source, its document and its passages. Status "ready" and timestamps 1. */
export function seedSource(db: DatabaseSync, source: SeedSource) {
  const kind = source.kind ?? "excerpt";
  insert(db, "sources", {
    id: source.id,
    kind,
    title: source.title,
    status: source.status ?? "ready",
    library: source.library === null ? undefined : (source.library ?? 1),
    created_at: 1,
    updated_at: 1,
  });
  if (!source.document) return;
  insert(db, "source_documents", {
    id: source.document.id,
    source_id: source.id,
    version: 1,
    tree_json: JSON.stringify(source.document.tree ?? { kind }),
    created_at: 1,
  });
  for (const passage of source.passages ?? [])
    insert(db, "passages", {
      id: passage.id,
      source_id: source.id,
      document_id: source.document.id,
      text: passage.text,
      locator_json:
        passage.locator === undefined ? undefined : JSON.stringify(passage.locator),
      section_path: passage.section,
      created_at: 1,
    });
}
