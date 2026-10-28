import { AsyncLocalStorage } from "node:async_hooks";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import type { EngineResult } from "./funnel";

/** What a model call works for: the chat message or the job it belongs to. */
export type UsageScope = {
  chatId?: string;
  messageId?: string;
  jobId?: string;
  /** The job's kind, or `chat` for a chat turn and its check. */
  kind?: string;
};

export type UsageTotals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

const scope = new AsyncLocalStorage<UsageScope>();
let record: ((usage: EngineResult, scope: UsageScope) => void) | undefined;

/** Model calls made inside `fn` are counted for `next`, on top of the scope they already run in. */
export function withUsageScope<T>(next: UsageScope, fn: () => T): T {
  return scope.run({ ...scope.getStore(), ...next }, fn);
}

/** What the model call running right now works for, if it runs inside `withUsageScope`. */
export function currentUsageScope(): UsageScope | undefined {
  return scope.getStore();
}

/** Core stores each call's tokens. Tests and tools that open no workspace leave it unset. */
export function setUsageRecorder(
  recorder: ((usage: EngineResult, scope: UsageScope) => void) | undefined,
): void {
  record = recorder;
}

/** Called by `generate()` after each model call that returned, including schema repairs. */
export function reportUsage(result: EngineResult): void {
  if (!record) return;
  if (!result.inputTokens && !result.outputTokens) return;
  record(result, scope.getStore() ?? {});
}

export function storeUsage(
  db: Database.Database,
  usage: EngineResult,
  where: UsageScope,
  now = Date.now(),
): void {
  db.prepare(
    `INSERT INTO engine_usage
      (id, at, provider, model, kind, chat_id, message_id, job_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuidv7(now),
    now,
    usage.provider,
    usage.model || null,
    where.kind ?? null,
    where.chatId ?? null,
    where.messageId ?? null,
    where.jobId ?? null,
    usage.inputTokens || 0,
    usage.outputTokens ?? 0,
    usage.cacheReadTokens ?? 0,
    usage.cacheWriteTokens ?? 0,
  );
}

const totals = `COUNT(*) AS calls,
  COALESCE(SUM(input_tokens), 0) AS inputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens`;

/** Tokens per engine since a moment, most used first. */
export function usageSince(
  db: Database.Database,
  since: number,
): Array<UsageTotals & { provider: string }> {
  return db
    .prepare(
      `SELECT provider, ${totals} FROM engine_usage WHERE at >= ?
       GROUP BY provider ORDER BY inputTokens + outputTokens DESC, provider`,
    )
    .all(since) as Array<UsageTotals & { provider: string }>;
}

/** Tokens a chat used, its replaced and stopped replies and its math checks included. Null before its first counted call. */
export function chatUsage(
  db: Database.Database,
  chatId: string,
): UsageTotals | null {
  const row = db
    .prepare(`SELECT ${totals} FROM engine_usage WHERE chat_id = ?`)
    .get(chatId) as UsageTotals;
  return row.calls > 0 ? row : null;
}
