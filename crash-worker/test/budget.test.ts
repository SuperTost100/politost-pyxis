import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BUDGET } from "../src/budget";
import { handle } from "../src/reports";

const base = "https://pyxis-crash.tost100bar.workers.dev";

const report = {
  appVersion: "0.4.1",
  electronVersion: "45.0.0",
  os: "linux",
  arch: "x64",
  process: "main",
  name: "Error",
  message: "boom",
  stack: "at <app>/out/main/index.js:10:5",
};

const allow = { limit: async () => ({ success: true }) };

/** A fresh counter per test: each named instance has its own storage. */
function budget(name: string) {
  return env.BUDGET.get(env.BUDGET.idFromName(name));
}

function testEnv(name: string): Env {
  const stub = budget(name);
  return {
    ...env,
    CLIENT_LIMIT: allow,
    ROUTE_LIMIT: allow,
    BUDGET: { idFromName: () => stub.id, get: () => stub },
  } as unknown as Env;
}

function postError(): Request {
  return new Request(`${base}/error`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    body: JSON.stringify(report),
  });
}

/** An uncompressed Crashpad-style upload with a minidump of `size` bytes. */
async function postMinidump(size: number): Promise<Request> {
  const dump = new Uint8Array(size);
  dump.set(new TextEncoder().encode("MDMP"));
  const form = new FormData();
  for (const [key, value] of Object.entries({
    _productName: "PoliTost Pyxis",
    _version: "0.4.1",
    ver: "45.0.0",
    platform: "linux",
    process_type: "browser",
  }))
    form.append(key, value);
  form.append("upload_file_minidump", new File([dump], "upload_file_minidump"));
  const encoded = new Response(form);
  return new Request(`${base}/minidump`, {
    method: "POST",
    headers: { "content-type": encoded.headers.get("content-type")!, "cf-connecting-ip": "203.0.113.9" },
    body: await encoded.arrayBuffer(),
  });
}

async function stored(day: string): Promise<number> {
  return (await env.REPORTS.list({ prefix: `${day}/` })).objects.length;
}

describe("daily budget", () => {
  it("allows reports up to the daily count, then refuses until the next UTC day", async () => {
    const counter = budget("count");
    for (let i = 0; i < BUDGET.reportsPerDay; i++) expect(await counter.reserve("2027-01-01", "error", 100)).toBe("stored");
    expect(await counter.reserve("2027-01-01", "error", 100)).toBe("full");
    expect(await counter.reserve("2027-01-01", "minidump", 100)).toBe("full");
    expect(await counter.reserve("2027-01-02", "error", 100)).toBe("stored");
  });

  it("caps minidumps on their own, inside the daily count", async () => {
    const counter = budget("minidumps");
    for (let i = 0; i < BUDGET.minidumpsPerDay; i++)
      expect(await counter.reserve("2027-02-01", "minidump", 1000)).toBe("stored");
    expect(await counter.reserve("2027-02-01", "minidump", 1000)).toBe("full");
    expect(await counter.reserve("2027-02-01", "error", 1000)).toBe("stored");
  });

  it("caps the bytes stored a day: a report too big for what is left is refused without using any of it", async () => {
    const counter = budget("bytes");
    expect(await counter.reserve("2027-03-01", "minidump", BUDGET.bytesPerDay - 1000)).toBe("stored");
    expect(await counter.reserve("2027-03-01", "minidump", 1001)).toBe("too-big");
    expect(await counter.reserve("2027-03-01", "error", 1000)).toBe("stored");
    expect(await counter.reserve("2027-03-01", "error", 1)).toBe("full");
  });

  it("still takes the smallest valid report when only 200 bytes are left", async () => {
    const counter = budget("edge");
    expect(await counter.reserve("2027-09-01", "minidump", BUDGET.bytesPerDay - 200)).toBe("stored");
    expect(await counter.reserve("2027-09-01", "error", 199)).toBe("stored");
    expect(await counter.reserve("2027-09-01", "error", 1)).toBe("full");
  });

  it("keeps a whole month under the monthly byte cap, and starts again the next month", async () => {
    const counter = budget("month");
    let allowed = 0;
    let refused = 0;
    for (let d = 1; d <= 31; d++) {
      const day = `2027-05-${String(d).padStart(2, "0")}`;
      if ((await counter.reserve(day, "minidump", BUDGET.bytesPerDay)) === "stored") allowed += BUDGET.bytesPerDay;
      else refused += 1;
    }
    expect(allowed).toBeLessThanOrEqual(BUDGET.bytesPerMonth);
    expect(refused).toBeGreaterThan(0);
    expect(await counter.reserve("2027-06-01", "minidump", BUDGET.bytesPerDay)).toBe("stored");
  });

  it("answers 503 and stores nothing once the day's budget is spent", async () => {
    const name = "handle";
    const counter = budget(name);
    const now = new Date(Date.UTC(2027, 5, 1, 12));
    for (let i = 0; i < BUDGET.reportsPerDay; i++) await counter.reserve("2027-06-01", "error", 1);
    const response = await handle(postError(), testEnv(name), now);
    expect(response.status).toBe(503);
    expect(Number(response.headers.get("retry-after"))).toBe(12 * 3600);
    expect(await stored("2027-06-01")).toBe(0);
  });

  it("keeps taking reports in this isolate after one was only too big for the bytes left", async () => {
    const name = "too-big";
    const counter = budget(name);
    const now = new Date(Date.UTC(2027, 7, 1, 12));
    expect(await counter.reserve("2027-08-01", "minidump", BUDGET.bytesPerDay - 2000)).toBe("stored");
    const big = await handle(await postMinidump(4000), testEnv(name), now);
    expect(big.status).toBe(503);
    expect((await handle(postError(), testEnv(name), now)).status).toBe(204);
  });

  it("gives the room back when the write to R2 fails and nothing was stored", async () => {
    const name = "write-fails";
    const stub = budget(name);
    const failing = {
      ...env,
      CLIENT_LIMIT: allow,
      ROUTE_LIMIT: allow,
      BUDGET: { idFromName: () => stub.id, get: () => stub },
      REPORTS: {
        put: async () => {
          throw new Error("R2 unavailable");
        },
        head: async () => null,
      },
    } as unknown as Env;
    const now = new Date(Date.UTC(2027, 9, 1, 12));
    for (let i = 0; i < BUDGET.reportsPerDay; i++)
      await expect(handle(postError(), failing, now)).rejects.toThrow("R2 unavailable");
    // Every failed write gave its place back, so the day still has room for all of them.
    expect((await handle(postError(), testEnv(name), now)).status).toBe(204);
  });

  it("stores a report while the budget lasts", async () => {
    const now = new Date(Date.UTC(2027, 6, 1, 12));
    expect((await handle(postError(), testEnv("ok"), now)).status).toBe(204);
    expect(await stored("2027-07-01")).toBe(1);
  });
});
