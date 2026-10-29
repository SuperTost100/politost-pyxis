import { DurableObject } from "cloudflare:workers";

/**
 * The most the Worker stores, whoever sends what. The rate limits count per Cloudflare location, so a sender spread
 * over many locations could still fill the bucket; this budget is one counter for all of them, and every report needs
 * room in it before it is written.
 *
 * At these numbers the bucket stays inside R2's free tier: 3 GB a month for 90 days is 9 GB of the 10 GB free, and
 * 300 writes a day is about 9,000 of the million free write operations a month. Pyxis itself sends far less.
 */
export const BUDGET = {
  /** Reports stored per UTC day, errors and minidumps together. */
  reportsPerDay: 300,
  /** Minidumps stored per UTC day, inside `reportsPerDay`. */
  minidumpsPerDay: 50,
  /** Bytes stored per UTC day. */
  bytesPerDay: 100 * 1024 * 1024,
  /** Bytes stored per calendar month (UTC). */
  bytesPerMonth: 3 * 1024 * 1024 * 1024,
} as const;

export type ReportKind = "error" | "minidump";

/**
 * `stored`: room was taken. `full`: no report of this kind fits until the next day (or month), so a caller may stop
 * asking. `too-big`: this report doesn't fit in the bytes left, but a smaller one still might.
 */
export type Reservation = "stored" | "full" | "too-big";

/** Below this many bytes left, no report fits any more: the smallest valid minidump is 32 bytes, and an error more. */
const MIN_REPORT_BYTES = 32;

/** Days of counts kept; older rows are deleted as new days start. */
const KEEP_DAYS = 40;

/**
 * One instance (named "global") holds the counts. A Durable Object runs one request at a time, so two reports can
 * never both take the last place.
 */
export class Budget extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, reports INTEGER NOT NULL, minidumps INTEGER NOT NULL, bytes INTEGER NOT NULL)",
    );
  }

  /** Takes room for one report on `day` (YYYY-MM-DD, UTC) and says whether it fit. A refusal takes nothing. */
  reserve(day: string, kind: ReportKind, bytes: number): Reservation {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isSafeInteger(bytes) || bytes < 0) return "too-big";
    const sql = this.ctx.storage.sql;
    const today = sql.exec<{ reports: number; minidumps: number; bytes: number }>(
      "SELECT reports, minidumps, bytes FROM usage WHERE day = ?",
      day,
    ).toArray()[0] ?? { reports: 0, minidumps: 0, bytes: 0 };
    const month = sql.exec<{ bytes: number }>(
      "SELECT COALESCE(SUM(bytes), 0) AS bytes FROM usage WHERE day LIKE ?",
      `${day.slice(0, 7)}-%`,
    ).one().bytes;
    const minidump = kind === "minidump" ? 1 : 0;
    const bytesLeft = Math.min(BUDGET.bytesPerDay - today.bytes, BUDGET.bytesPerMonth - month);
    if (
      today.reports + 1 > BUDGET.reportsPerDay ||
      today.minidumps + minidump > BUDGET.minidumpsPerDay ||
      bytesLeft < MIN_REPORT_BYTES
    )
      return "full";
    if (bytes > bytesLeft) return "too-big";
    sql.exec(
      `INSERT INTO usage (day, reports, minidumps, bytes) VALUES (?, 1, ?, ?)
       ON CONFLICT(day) DO UPDATE SET reports = reports + 1, minidumps = minidumps + excluded.minidumps, bytes = bytes + excluded.bytes`,
      day,
      minidump,
      bytes,
    );
    const oldest = new Date(Date.parse(`${day}T00:00:00Z`) - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    sql.exec("DELETE FROM usage WHERE day < ?", oldest);
    return "stored";
  }

  /** Gives back the room `reserve` took for a report that was then not stored. */
  release(day: string, kind: ReportKind, bytes: number): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isSafeInteger(bytes) || bytes < 0) return;
    this.ctx.storage.sql.exec(
      `UPDATE usage SET reports = MAX(reports - 1, 0), minidumps = MAX(minidumps - ?, 0), bytes = MAX(bytes - ?, 0)
       WHERE day = ?`,
      kind === "minidump" ? 1 : 0,
      bytes,
      day,
    );
  }
}
