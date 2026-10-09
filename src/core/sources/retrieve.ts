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

let modelEmbed:
  | ((text: string, signal?: AbortSignal) => Promise<Float32Array | null>)
  | undefined;
export function setRetrievalModel(embed: typeof modelEmbed): void {
  modelEmbed = embed;
}

/** The local model's vector for a short text, or null when the model is unavailable. */
export async function embedWithModel(
  text: string,
  signal?: AbortSignal,
): Promise<Float32Array | null> {
  return modelEmbed ? modelEmbed(text, signal) : null;
}

export async function retrieveWithModel(
  db: Database.Database,
  query: string,
  options?: {
    sourceIds?: string[];
    limit?: number;
    embed?: Embedder | null;
    signal?: AbortSignal;
  },
) {
  if (options?.embed !== undefined || !modelEmbed)
    return retrieve(db, query, options);
  const vector = await modelEmbed(`query: ${query}`, options?.signal);
  return retrieve(db, query, {
    ...options,
    embed: vector ? () => vector : null,
  });
}

type Row = {
  id: string;
  source_id: string | null;
  text: string;
  section_path: string | null;
  locator_json: string | null;
  rank: number;
};

/** Passages this near (L2 on normalized e5 vectors) join the fused ranking. Recall only; coverage uses the stricter bound below. */
const VECTOR_MAX_DISTANCE = 0.8;
/**
 * SRC-23: the best vector alone calls a question covered at or under this L2 distance (cosine about 0.82).
 * ponytail: measured, not tuned to a target. With the pinned multilingual-e5-small on 3 small sources, short passages and
 * 1,400-character chunks (`retrieve-real-model.test.ts`): same-language related questions in Italian and English
 * landed at 0.37-0.58, obviously unrelated ones (cooking, history, sport, marketing, geography) at 0.66-0.75, so 0.60
 * splits those with room on both sides. The old 0.8 admitted all of them. Limits: a question in the other language than
 * the source (0.59-0.67) and a neighbouring subject (maths asked of a physics source, 0.59-0.66) fall in the same
 * band, so the former can read as "not covered" and the latter as covered. A larger source probably pulls unrelated
 * questions nearer (not measured). Chat no longer stops on this flag: it sends the passages found and the model decides which to cite. The flag only widens a follow-up's search.
 */
const VECTOR_COVERED_MAX_DISTANCE = 0.6;

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

export function trimToBudget(
  hits: PassageHit[],
  maxTokens = 12_000,
): PassageHit[] {
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
  "ancora",
  "sulla",
  "sullo",
  "sulle",
  "sul",
  "su",
  "spiega",
  "explain",
  "again",
  "about",
  "tell",
  "me",
  "definition",
  "definizione",
]);

export function contentWords(query: string): string[] {
  const words = query.match(/\p{L}[\p{L}\p{N}]*/gu) ?? [];
  const kept = words.filter(
    (word) => word.length >= 3 && !STOP.has(word.toLocaleLowerCase("it")),
  );
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

function lexical(
  db: Database.Database,
  query: string,
  sourceIds?: string[],
): Row[] {
  const words = contentWords(query);
  if (words.length === 0) return [];
  const match = words
    .map((word) => `"${word.replaceAll('"', "")}"`)
    .join(" OR ");
  const scope =
    sourceIds && sourceIds.length > 0
      ? ` AND p.source_id IN (${sourceIds.map(() => "?").join(", ")})`
      : " AND (p.source_id IS NULL OR s.library = 1)";
  return db
    .prepare(
      `SELECT p.id, p.source_id, p.text, p.section_path, p.locator_json,
              bm25(passages_fts) AS rank
       FROM passages_fts
       JOIN passages p ON p.rowid = passages_fts.rowid
       LEFT JOIN sources s ON s.id = p.source_id
       WHERE passages_fts MATCH ?${scope}
         AND (p.source_id IS NULL OR s.status NOT IN ('removed', 'failed', 'cancelled', 'interrupted'))
         AND (
           p.source_id IS NULL
           OR p.document_id = (
             SELECT id FROM source_documents
             WHERE source_id = p.source_id
             ORDER BY version DESC
             LIMIT 1
           )
         )
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
  const bytes = Buffer.from(
    vector.buffer,
    vector.byteOffset,
    vector.byteLength,
  );
  // Scope before KNN ranking. Filtering a global top 30 can hide all scoped hits.
  const scope = sourceIds?.length
    ? `AND p.source_id IN (${sourceIds.map(() => "?").join(",")})`
    : "AND (p.source_id IS NULL OR s.library = 1)";
  const rows = db
    .prepare(
      `SELECT passage_rowid AS n, distance FROM passages_vec
       WHERE embedding MATCH ? AND k = 30 AND passage_rowid IN (
         SELECT p.rowid FROM passages p LEFT JOIN sources s ON s.id = p.source_id
         WHERE (p.source_id IS NULL OR s.status NOT IN ('removed', 'failed', 'cancelled', 'interrupted')) ${scope}
         AND (p.source_id IS NULL OR p.document_id = (SELECT id FROM source_documents
           WHERE source_id = p.source_id ORDER BY version DESC LIMIT 1)))
       ORDER BY distance`,
    )
    .all(bytes, ...(sourceIds ?? [])) as Array<{
    n: number | bigint;
    distance: number;
  }>;
  const ids: string[] = [];
  let bestDistance: number | null = null;
  const lookup = db.prepare(
    `SELECT p.id, p.source_id FROM passages p
     LEFT JOIN sources s ON s.id = p.source_id
     WHERE p.rowid = ?
       AND (p.source_id IS NULL OR s.status NOT IN ('removed', 'failed', 'cancelled', 'interrupted'))
       AND (
         p.source_id IS NULL
         OR p.document_id = (
           SELECT id FROM source_documents
           WHERE source_id = p.source_id
           ORDER BY version DESC
           LIMIT 1
         )
       )`,
  );
  for (const row of rows) {
    const found = lookup.get(Number(row.n)) as
      { id: string; source_id: string | null } | undefined;
    if (!found) continue;
    if (
      sourceIds &&
      sourceIds.length > 0 &&
      !sourceIds.includes(found.source_id ?? "")
    ) {
      continue;
    }
    if (bestDistance == null || row.distance < bestDistance)
      bestDistance = row.distance;
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
    const vectorNear =
      bestDistance != null && bestDistance <= VECTOR_MAX_DISTANCE;
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
  // SRC-23: inspect raw BM25 and term coverage, before rank fusion.
  const words = [
    ...new Set(
      contentWords(query).map((word) =>
        word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase(),
      ),
    ),
  ];
  const lexicalOk = lexicalRows.some((row) => {
    const tokens = new Set(
      row.text
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .match(/\p{L}[\p{L}\p{N}]*/gu) ?? [],
    );
    const matches = words.filter((word) => tokens.has(word)).length;
    return (
      -row.rank >= 1e-7 && matches >= Math.max(1, Math.ceil(words.length * 0.4))
    );
  });
  const vectorOk =
    bestDistance != null && bestDistance <= VECTOR_COVERED_MAX_DISTANCE;
  const covered = options?.embed ? lexicalOk || vectorOk : lexicalOk;
  const hits = trimToBudget(
    fuseRanks(lists)
      .map((id) => byId.get(id))
      .filter((hit): hit is PassageHit => hit != null),
  ).slice(0, limit);
  return { hits, covered, usedVectors };
}
