import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { deleteExpired, RETENTION_DAYS } from "../src/retention";

const DAY = 86_400_000;
const now = new Date(Date.UTC(2027, 4, 20, 3, 17));

function dayKey(daysAgo: number): string {
  return new Date(now.getTime() - daysAgo * DAY).toISOString().slice(0, 10);
}

async function keys(): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.REPORTS.list({ cursor });
    found.push(...page.objects.map((object) => object.key));
    if (!page.truncated) return found.sort();
    cursor = page.cursor;
  }
}

async function put(key: string): Promise<void> {
  await env.REPORTS.put(key, "x");
}

async function clear(): Promise<void> {
  const all = await keys();
  if (all.length) await env.REPORTS.delete(all);
}

describe("retention", () => {
  it(`deletes reports older than ${RETENTION_DAYS} days and keeps newer ones`, async () => {
    await clear();
    await put(`${dayKey(91)}/error/a.json`);
    await put(`${dayKey(91)}/minidump/b.dmp`);
    await put(`${dayKey(400)}/error/c.json`);
    await put(`${dayKey(90)}/error/d.json`);
    await put(`${dayKey(89)}/error/e.json`);
    await put(`${dayKey(0)}/minidump/f.dmp`);
    const removed = await deleteExpired(env.REPORTS, now);
    expect(removed).toBe(3);
    expect(await keys()).toEqual(
      [`${dayKey(90)}/error/d.json`, `${dayKey(89)}/error/e.json`, `${dayKey(0)}/minidump/f.dmp`].sort(),
    );
  });

  it("leaves keys that do not start with a date alone", async () => {
    await clear();
    await put("notes/readme.txt");
    await put("2020-13-99/error/x.json");
    await put(`${dayKey(200)}`);
    expect(await deleteExpired(env.REPORTS, now)).toBe(0);
    expect(await keys()).toHaveLength(3);
  });

  it("pages through the day prefixes and through each day's objects", async () => {
    await clear();
    const old: string[] = [];
    for (const daysAgo of [95, 96, 97, 98, 99])
      for (let index = 0; index < 5; index += 1) old.push(`${dayKey(daysAgo)}/error/${index}.json`);
    for (const key of old) await put(key);
    await put(`${dayKey(10)}/error/keep.json`);
    const removed = await deleteExpired(env.REPORTS, now, { pageSize: 2 });
    expect(removed).toBe(old.length);
    expect(await keys()).toEqual([`${dayKey(10)}/error/keep.json`]);
  });

  it("runs from the daily cron trigger", async () => {
    await clear();
    await put(`${dayKey(91)}/error/a.json`);
    await put(`${dayKey(1)}/error/b.json`);
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => waits.push(promise), passThroughOnException() {} };
    await worker.scheduled!(
      { scheduledTime: now.getTime(), cron: "17 3 * * *", noRetry() {} },
      env,
      ctx as unknown as ExecutionContext,
    );
    await Promise.all(waits);
    expect(await keys()).toEqual([`${dayKey(1)}/error/b.json`]);
  });
});
