import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Embedder } from "./retrieve";
import { sha256 } from "./quality";
import { runSourceWorker } from "./worker-client";

export const EMBEDDING_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
export const MODEL_FILES = {
  "onnx/model_quantized.onnx": "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
  "config.json": "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
  "tokenizer.json": "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
  "tokenizer_config.json": "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
  "special_tokens_map.json": "d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7",
} as const;

export const EMBEDDING_URL =
  `https://huggingface.co/Xenova/multilingual-e5-small/resolve/${EMBEDDING_REVISION}/onnx/model_quantized.onnx`;

/**
 * SHA-256 of Xenova multilingual-e5-small `onnx/model_quantized.onnx`.
 * Filled when the file is pinned. A download with a different hash is refused.
 */
export const EMBEDDING_SHA256 =
  "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193";

const CONSENT_KEY = "embedding.consent";
const MAX_BYTES = 200 * 1024 * 1024;

export function setEmbeddingConsent(db: Database.Database, accepted: boolean): void {
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(CONSENT_KEY, JSON.stringify(accepted), Date.now());
}

export function embeddingConsent(db: Database.Database): boolean {
  const row = db
    .prepare(`SELECT value_json FROM settings WHERE key = ?`)
    .get(CONSENT_KEY) as { value_json: string } | undefined;
  if (!row) return false;
  return JSON.parse(row.value_json) === true;
}

export async function downloadEmbedding(options: {
  dir: string;
  url?: string;
  sha256: string;
  consent: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  fileName?: string;
}): Promise<"ready" | "declined"> {
  if (!options.consent) return "declined";
  if (!/^[a-f0-9]{64}$/.test(options.sha256) || /^0+$/.test(options.sha256)) {
    throw new Error("embed-unpinned");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(options.url ?? EMBEDDING_URL, { signal: options.signal });
  if (!response.ok) throw new Error("embed-download");
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        options.signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error("embed-too-big");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
  } else {
    chunks.push(new Uint8Array(await response.arrayBuffer()));
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength > MAX_BYTES) throw new Error("embed-too-big");
  if (sha256(bytes) !== options.sha256) throw new Error("embed-hash");
  options.signal?.throwIfAborted();
  const file = join(options.dir, options.fileName ?? "model_quantized.onnx");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(`${file}.part`, bytes);
  renameSync(`${file}.part`, file);
  return "ready";
}

export function embeddingReady(dir: string): boolean {
  return Object.keys(MODEL_FILES).every((name) => existsSync(join(dir, name)));
}

export async function downloadModel(dir: string, signal: AbortSignal): Promise<void> {
  for (const [name, hash] of Object.entries(MODEL_FILES)) {
    signal.throwIfAborted();
    if (existsSync(join(dir, name)) && sha256(readFileSync(join(dir, name))) === hash) continue;
    await downloadEmbedding({ dir, fileName: name, sha256: hash, consent: true, signal,
      url: `https://huggingface.co/Xenova/multilingual-e5-small/resolve/${EMBEDDING_REVISION}/${name}` });
  }
}

export async function embedTexts(dir: string, texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  const vectors = await runSourceWorker<number[][]>("embed-worker", { dir, texts }, signal);
  return vectors.map((vector) => {
    if (vector.length !== 384 || vector.some((n) => !Number.isFinite(n))) throw new Error("embed-dim");
    return Float32Array.from(vector);
  });
}

// SRC-21: committed batches survive a cancelled or interrupted indexing job.
export async function indexModelVectors(db: Database.Database, dir: string, signal: AbortSignal, sourceId?: string): Promise<number> {
  let count = 0;
  for (;;) {
    signal.throwIfAborted();
    const rows = db.prepare(`SELECT p.rowid AS n, p.text FROM passages p
      LEFT JOIN sources s ON s.id = p.source_id
      WHERE (? IS NULL OR p.source_id = ?) AND (p.source_id IS NULL OR s.status != 'removed')
        AND (p.source_id IS NULL OR p.document_id = (SELECT id FROM source_documents
          WHERE source_id = p.source_id ORDER BY version DESC LIMIT 1))
        AND NOT EXISTS (SELECT 1 FROM passages_vec v WHERE v.passage_rowid = p.rowid)
      ORDER BY p.rowid LIMIT 32`).all(sourceId ?? null, sourceId ?? null) as Array<{ n: number; text: string }>;
    if (rows.length === 0) return count;
    const vectors = await embedTexts(dir, rows.map((row) => `passage: ${row.text}`), signal);
    signal.throwIfAborted();
    db.transaction(() => {
      const insert = db.prepare(`INSERT INTO passages_vec (passage_rowid, embedding) VALUES (?, ?)`);
      const indexed = db.prepare(`SELECT 1 FROM passages_vec WHERE passage_rowid = ?`);
      rows.forEach((row, index) => {
        // A source may have been removed, or replaced or read again, while inference was running. A batch that was read
        // from a version that is no longer the latest writes nothing, so a late job never indexes superseded text.
        if (!indexed.get(BigInt(row.n)) && db.prepare(`SELECT 1 FROM passages p LEFT JOIN sources s ON s.id = p.source_id
          WHERE p.rowid = ? AND (p.source_id IS NULL OR (s.status != 'removed' AND p.document_id = (SELECT id FROM source_documents
            WHERE source_id = p.source_id ORDER BY version DESC LIMIT 1)))`).get(row.n)) {
          insert.run(BigInt(row.n), Buffer.from(vectors[index]!.buffer));
        }
      });
    })();
    count += rows.length;
  }
}

/** Write vectors for passages that do not have one yet. The caller owns the model. */
export function indexVectors(db: Database.Database, embed: Embedder): number {
  const rows = db
    .prepare(
      `SELECT p.rowid AS n, p.text FROM passages p
       WHERE p.source_id IS NULL
          OR p.document_id = (
            SELECT id FROM source_documents
            WHERE source_id = p.source_id
            ORDER BY version DESC
            LIMIT 1
          )`,
    )
    .all() as Array<{ n: number; text: string }>;
  const has = db.prepare(`SELECT 1 AS n FROM passages_vec WHERE passage_rowid = ?`);
  const insert = db.prepare(
    `INSERT INTO passages_vec (passage_rowid, embedding) VALUES (?, ?)`,
  );
  let count = 0;
  for (const row of rows) {
    const key = BigInt(row.n);
    if (has.get(key)) continue;
    const vector = embed(`passage: ${row.text}`);
    if (vector.length !== 384) throw new Error("embed-dim");
    const tight = new Float32Array(vector);
    insert.run(key, Buffer.from(tight.buffer));
    count += 1;
  }
  return count;
}
