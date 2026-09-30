import type Database from "better-sqlite3";

export type PassageLocator = {
  chapter?: number;
  paragraph?: string;
  page?: number;
  slide?: number;
};

export type PassageHit = {
  id: string;
  sourceId: string;
  text: string;
  sectionPath: string | null;
  locator: PassageLocator;
};

export type Embedder = (text: string) => Float32Array;

type Row = {
  id: string;
  source_id: string | null;
  text: string;
  section_path: string | null;
  locator_json: string | null;
  rank: number;
};

const VECTOR_MAX_DISTANCE = 0.8;

export function fuseRanks(lists: string[][], k = 60): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
}

export function trimToBudget(hits: PassageHit[], maxTokens = 12_000): PassageHit[] {
  const kept: PassageHit[] = [];
  let tokens = 0;
  for (const hit of hits) {
    const cost = Math.max(1, Math.ceil(hit.text.length / 4));
    if (kept.length > 0 && tokens + cost > maxTokens) break;
    kept.push(hit);
    tokens += cost;
  }
  return kept;
}

const STOP = new Set([
  "che",
  "cos",
  "cosa",
  "come",
  "il",
  "lo",
  "la",
  "i",
  "gli",
  "le",
  "un",
  "una",
  "di",
  "del",
  "della",
  "dei",
  "the",
  "what",
  "how",
  "and",
  "per",
  "con",
  "non",
]);

export function contentWords(query: string): string[] {
  const words = query.match(/\p{L}[\p{L}\p{N}]*/gu) ?? [];
  const kept = words.filter((word) => word.length >= 3 && !STOP.has(word.toLocaleLowerCase("it")));
  return (kept.length > 0 ? kept : words).slice(0, 8);
}

function hitOf(row: Row): PassageHit {
  return {
    id: row.id,
    sourceId: row.source_id ?? "",
    text: row.text,
    sectionPath: row.section_path,
    locator: row.locator_json
      ? (JSON.parse(row.locator_json) as PassageLocator)
      : {},
  };
}

function lexical(db: Database.Database, query: string, sourceIds?: string[]): Row[] {
  const words = contentWords(query);
  if (words.length === 0) return [];
  const match = words.map((word) => `"${word.replaceAll('"', "")}"`).join(" OR ");
  const scope =
    sourceIds && sourceIds.length > 0
      ? ` AND p.source_id IN (${sourceIds.map(() => "?").join(", ")})`
      : "";
  return db
    .prepare(
      `SELECT p.id, p.source_id, p.text, p.section_path, p.locator_json,
              bm25(passages_fts) AS rank
       FROM passages_fts
       JOIN passages p ON p.rowid = passages_fts.rowid
       WHERE passages_fts MATCH ?${scope}
       ORDER BY rank
       LIMIT 30`,
    )
    .all(match, ...(sourceIds ?? [])) as Row[];
}

function vectorHits(
  db: Database.Database,
  embed: Embedder,
  query: string,
  sourceIds?: string[],
): { ids: string[]; bestDistance: number | null } {
  const vector = embed(`query: ${query}`);
  const bytes = Buffer.from(vector.buffer);
  const rows = db
    .prepare(
      `SELECT passage_rowid AS n, distance FROM passages_vec
       WHERE embedding MATCH ? AND k = 30
       ORDER BY distance`,
    )
    .all(bytes) as Array<{ n: number | bigint; distance: number }>;
  const ids: string[] = [];
  let bestDistance: number | null = null;
  const lookup = db.prepare(
    `SELECT id, source_id FROM passages WHERE rowid = ?`,
  );
  for (const row of rows) {
    const found = lookup.get(Number(row.n)) as
      | { id: string; source_id: string | null }
      | undefined;
    if (!found) continue;
    if (sourceIds && sourceIds.length > 0 && !sourceIds.includes(found.source_id ?? "")) {
      continue;
    }
    if (bestDistance == null || row.distance < bestDistance) bestDistance = row.distance;
    if (row.distance <= VECTOR_MAX_DISTANCE) ids.push(found.id);
  }
  return { ids, bestDistance };
}

export function retrieve(
  db: Database.Database,
  query: string,
  options?: { sourceIds?: string[]; limit?: number; embed?: Embedder | null },
): { hits: PassageHit[]; covered: boolean; usedVectors: boolean } {
  const limit = options?.limit ?? 8;
  const lexicalRows = lexical(db, query, options?.sourceIds);
  const byId = new Map(lexicalRows.map((row) => [row.id, hitOf(row)]));
  const lists = [lexicalRows.map((row) => row.id)];
  let usedVectors = false;
  let bestDistance: number | null = null;
  if (options?.embed) {
    const vectors = vectorHits(db, options.embed, query, options.sourceIds);
    bestDistance = vectors.bestDistance;
    const vectorNear = bestDistance != null && bestDistance <= VECTOR_MAX_DISTANCE;
    if (vectorNear) {
      usedVectors = true;
      lists.push(vectors.ids);
      const missing = vectors.ids.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        const placeholders = missing.map(() => "?").join(", ");
        const extra = db
          .prepare(
            `SELECT id, source_id, text, section_path, locator_json, 0 AS rank
             FROM passages WHERE id IN (${placeholders})`,
          )
          .all(...missing) as Row[];
        for (const row of extra) byId.set(row.id, hitOf(row));
      }
    }
  }
  const lexicalOk = lexicalRows.length > 0;
  const vectorOk = bestDistance != null && bestDistance <= VECTOR_MAX_DISTANCE;
  const covered = options?.embed ? lexicalOk || vectorOk : lexicalOk;
  const hits = trimToBudget(
    fuseRanks(lists)
      .map((id) => byId.get(id))
      .filter((hit): hit is PassageHit => hit != null),
  ).slice(0, limit);
  return { hits, covered, usedVectors };
}
