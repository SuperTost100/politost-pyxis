/**
 * Reports are kept 90 days. An R2 lifecycle rule deletes them (docs/crash-reports.md); this daily sweep deletes them
 * too, so the promise holds even if the rule is missing or was changed by hand.
 */
export const RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;
const DAY_PREFIX = /^(\d{4}-\d{2}-\d{2})\/$/;

function isRealDay(day: string): boolean {
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

/**
 * Deletes every object under a `<YYYY-MM-DD>/` prefix more than 90 days before `now`. A report from exactly 90 days
 * ago stays until the next day's sweep. Keys that do not start with a real date are left alone. Returns how many
 * objects went. `pageSize` is for tests; `maxListings` bounds one run's requests, and the next run carries on.
 */
export async function deleteExpired(
  bucket: R2Bucket,
  now: Date,
  options: { pageSize?: number; maxListings?: number } = {},
): Promise<number> {
  const pageSize = options.pageSize ?? 1000;
  let listings = options.maxListings ?? 200;
  // ISO dates sort as text, so a day before the cutoff is one that compares lower.
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
  const expired: string[] = [];
  let cursor: string | undefined;
  do {
    if (listings-- <= 0) break;
    const page = await bucket.list({ delimiter: "/", limit: pageSize, cursor });
    for (const prefix of page.delimitedPrefixes) {
      const day = DAY_PREFIX.exec(prefix)?.[1];
      if (day && isRealDay(day) && day < cutoff) expired.push(prefix);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  let removed = 0;
  for (const prefix of expired) {
    let pageCursor: string | undefined;
    do {
      if (listings-- <= 0) return removed;
      const page = await bucket.list({ prefix, limit: pageSize, cursor: pageCursor });
      const keys = page.objects.map((object) => object.key);
      if (keys.length) await bucket.delete(keys);
      removed += keys.length;
      pageCursor = page.truncated ? page.cursor : undefined;
    } while (pageCursor);
  }
  return removed;
}
