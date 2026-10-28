import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { handle, LIMITS, PRODUCT_NAME, parseErrorReport, redactHome } from "../src/reports";

const base = "https://pyxis-crash.tost100bar.workers.dev";

const report = {
  appVersion: "0.4.1",
  electronVersion: "44.9.3",
  os: "linux",
  arch: "x64",
  process: "renderer",
  name: "TypeError",
  message: "Cannot read properties of undefined (reading 'length')",
  stack: "at render (pyxis-app://app/assets/index-abc.js:1:2345)\nat <app>/out/main/index.js:10:5",
};

let days = 0;
/** A different day for every test, so each one lists only the objects it wrote. */
function freshDay(): Date {
  days += 1;
  return new Date(Date.UTC(2026, 0, 1) + days * 86_400_000);
}

function dayPrefix(now: Date): string {
  return now.toISOString().slice(0, 10);
}

type Limiter = { limit(options: { key: string }): Promise<{ success: boolean }> };
const allow: Limiter = { limit: async () => ({ success: true }) };
const deny: Limiter = { limit: async () => ({ success: false }) };
function testEnv(limits: { client?: Limiter; route?: Limiter } = {}): Env {
  return {
    ...env,
    CLIENT_LIMIT: limits.client ?? allow,
    ROUTE_LIMIT: limits.route ?? allow,
  } as unknown as Env;
}

function postError(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${base}/error`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function stored(now: Date, kind: "error" | "minidump") {
  const listed = await env.REPORTS.list({ prefix: `${dayPrefix(now)}/${kind}/`, include: ["customMetadata"] });
  return listed.objects;
}

function minidump(size = 1024): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("MDMP"));
  return bytes;
}

function crashpadForm(
  fields: Record<string, string> = {},
  dump: Uint8Array | null = minidump(),
  extraFile = false,
): FormData {
  const form = new FormData();
  const all = {
    _productName: PRODUCT_NAME,
    _version: "0.4.1",
    ver: "44.9.3",
    platform: "linux",
    process_type: "renderer",
    prod: "Electron",
    guid: "8f0c3d55-installation-id",
    _companyName: "PoliTost",
    ...fields,
  };
  for (const [key, value] of Object.entries(all)) form.append(key, value);
  if (dump) form.append("upload_file_minidump", new File([dump], "upload_file_minidump"));
  if (extraFile) form.append("attachment", new File(["x"], "attachment.txt"));
  return form;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The request Crashpad makes: the multipart body gzip-compressed, with Content-Encoding: gzip. */
async function postMinidump(form: FormData, options: { compress?: boolean } = {}): Promise<Request> {
  const encoded = new Response(form);
  const type = encoded.headers.get("content-type")!;
  const raw = new Uint8Array(await encoded.arrayBuffer());
  const compress = options.compress ?? true;
  return new Request(`${base}/minidump`, {
    method: "POST",
    headers: {
      "content-type": type,
      "cf-connecting-ip": "203.0.113.7",
      ...(compress ? { "content-encoding": "gzip" } : {}),
    },
    body: compress ? await gzip(raw) : raw,
  });
}

describe("routes", () => {
  it("answers 404 for any other path and 405 for other methods on the two routes", async () => {
    expect((await handle(new Request(`${base}/`), testEnv())).status).toBe(404);
    expect((await handle(new Request(`${base}/list`, { method: "POST" }), testEnv())).status).toBe(404);
    expect((await handle(new Request(`${base}/error/`, { method: "POST" }), testEnv())).status).toBe(404);
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS", "HEAD"]) {
      const response = await handle(new Request(`${base}/error`, { method }), testEnv());
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    expect((await handle(new Request(`${base}/minidump`), testEnv())).status).toBe(405);
  });

  it("goes through the default export", async () => {
    const response = await worker.fetch(new Request(`${base}/nothing`), testEnv());
    expect(response.status).toBe(404);
  });

  it("refuses a sender over the rate limit, per computer or for the whole route, and stores nothing", async () => {
    for (const limits of [{ client: deny }, { route: deny }]) {
      const now = freshDay();
      const response = await handle(postError(report), testEnv(limits), now);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(await stored(now, "error")).toHaveLength(0);
    }
  });

  it("keys the per-computer limit by route and address, and the route limit by route alone", async () => {
    const keys: string[] = [];
    const record: Limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) };
    await handle(postError(report), testEnv({ client: record, route: record }), freshDay());
    expect(keys.sort()).toEqual(["/error", "/error:203.0.113.7"]);
  });
});

describe("POST /error", () => {
  it("stores a valid report under its day, with a fingerprint and nothing about the sender", async () => {
    const now = freshDay();
    const response = await handle(postError(report, { "user-agent": "Pyxis", cookie: "a=b" }), testEnv(), now);
    expect(response.status).toBe(204);
    const objects = await stored(now, "error");
    expect(objects).toHaveLength(1);
    const object = objects[0]!;
    expect(object.key).toMatch(new RegExp(`^${dayPrefix(now)}/error/[0-9a-f-]{36}\\.json$`));
    const saved = (await (await env.REPORTS.get(object.key))!.json()) as Record<string, unknown>;
    expect(saved).toEqual({ receivedAt: now.toISOString(), fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/), ...report });
    expect(object.customMetadata).toEqual({ fingerprint: saved["fingerprint"], process: "renderer", appVersion: "0.4.1" });
    const everything = JSON.stringify({ saved, meta: object.customMetadata });
    expect(everything).not.toContain("203.0.113.7");
    expect(everything).not.toContain("Pyxis\"");
    expect(everything).not.toContain("a=b");
  });

  it("gives the same error the same fingerprint, whatever the numbers in its message", async () => {
    const first = freshDay();
    await handle(postError({ ...report, message: "index 3 out of range" }), testEnv(), first);
    await handle(postError({ ...report, message: "index 41 out of range" }), testEnv(), first);
    await handle(postError({ ...report, message: "another error" }), testEnv(), first);
    const prints = (await stored(first, "error")).map((object) => object.customMetadata!["fingerprint"]);
    expect(new Set(prints).size).toBe(2);
  });

  it("replaces an account name left in a home-folder path", async () => {
    const now = freshDay();
    await handle(
      postError({
        ...report,
        message: "ENOENT /home/mario/x and C:\\Users\\Mario Rossi\\y",
        stack: "at f (/Users/anna/Library/z.js:1:1)",
      }),
      testEnv(),
      now,
    );
    const object = (await stored(now, "error"))[0]!;
    const saved = (await (await env.REPORTS.get(object.key))!.json()) as typeof report;
    expect(saved.message).not.toMatch(/mario|Rossi/i);
    expect(saved.stack).not.toContain("anna");
    expect(redactHome("/home/mario/notes.pdf")).toBe("~/notes.pdf");
  });

  it.each([
    ["an extra field", { ...report, chat: "hello" }],
    ["a missing field", { ...report, stack: undefined }],
    ["a bad app version", { ...report, appVersion: "latest" }],
    ["a bad Electron version", { ...report, electronVersion: "44" }],
    ["an unknown OS", { ...report, os: "android" }],
    ["an unknown arch", { ...report, arch: "mips" }],
    ["an unknown process", { ...report, process: "gpu" }],
    ["a name that is not an identifier", { ...report, name: "Error: my notes" }],
    ["a message too long", { ...report, message: "x".repeat(LIMITS.message + 1) }],
    ["a stack too long", { ...report, stack: "x".repeat(LIMITS.stack + 1) }],
    ["a number for a string", { ...report, message: 42 }],
    ["a NUL character", { ...report, message: "a\u0000b" }],
    ["an array", [report]],
    ["null", null],
  ])("refuses %s with 400", async (_label, body) => {
    const now = freshDay();
    const response = await handle(postError(body), testEnv(), now);
    expect(response.status).toBe(400);
    expect(await stored(now, "error")).toHaveLength(0);
  });

  it("refuses a body that is not JSON or not UTF-8", async () => {
    expect((await handle(postError("{nope"), testEnv(), freshDay())).status).toBe(400);
    const latin1 = new Request(`${base}/error`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0x7b, 0xff, 0x7d]),
    });
    expect((await handle(latin1, testEnv(), freshDay())).status).toBe(400);
  });

  it("refuses another content type or a compressed body with 415", async () => {
    expect((await handle(postError(report, { "content-type": "text/plain" }), testEnv(), freshDay())).status).toBe(415);
    expect((await handle(postError(report, { "content-encoding": "gzip" }), testEnv(), freshDay())).status).toBe(415);
  });

  it("refuses a body over the cap with 413, whether declared or streamed", async () => {
    const now = freshDay();
    const big = JSON.stringify({ ...report, stack: "x".repeat(LIMITS.errorBytes) });
    expect((await handle(postError(big), testEnv(), now)).status).toBe(413);
    const declared = postError(report, { "content-length": String(LIMITS.errorBytes + 1) });
    expect((await handle(declared, testEnv(), now)).status).toBe(413);
    expect(await stored(now, "error")).toHaveLength(0);
  });

  it("parses exactly the eight fields", () => {
    expect(parseErrorReport(report)).toEqual(report);
    expect(parseErrorReport({ ...report, fingerprint: "x" })).toBeNull();
  });
});

describe("POST /minidump", () => {
  it("stores a gzip Crashpad upload with the allowed fields only and answers with the report id", async () => {
    const now = freshDay();
    const response = await handle(await postMinidump(crashpadForm()), testEnv(), now);
    expect(response.status).toBe(200);
    const id = await response.text();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const objects = await stored(now, "minidump");
    expect(objects.map((object) => object.key)).toEqual([`${dayPrefix(now)}/minidump/${id}.dmp`]);
    expect(objects[0]!.customMetadata).toEqual({
      receivedAt: now.toISOString(),
      appVersion: "0.4.1",
      electronVersion: "44.9.3",
      platform: "linux",
      processType: "renderer",
    });
    const saved = new Uint8Array(await (await env.REPORTS.get(objects[0]!.key))!.arrayBuffer());
    expect(saved).toEqual(minidump());
    expect(JSON.stringify(objects[0])).not.toContain("installation-id");
    expect(JSON.stringify(objects[0])).not.toContain("203.0.113.7");
  });

  it("takes an uncompressed upload too, and marks unknown platform and process values", async () => {
    const now = freshDay();
    const form = crashpadForm({ platform: "plan9", process_type: "Bad Type" });
    const response = await handle(await postMinidump(form, { compress: false }), testEnv(), now);
    expect(response.status).toBe(200);
    const meta = (await stored(now, "minidump"))[0]!.customMetadata!;
    expect(meta["platform"]).toBe("unknown");
    expect(meta["processType"]).toBe("unknown");
  });

  it.each([
    ["no minidump", crashpadForm({}, null)],
    ["a file that is not a minidump", crashpadForm({}, new TextEncoder().encode("not a dump at all, just some text here"))],
    ["a minidump too short", crashpadForm({}, new TextEncoder().encode("MDMP"))],
    ["a second file", crashpadForm({}, minidump(), true)],
    ["another product", crashpadForm({ _productName: "Other App" })],
    ["a bad app version", crashpadForm({ _version: "1" })],
    ["a missing Electron version", crashpadForm({ ver: "" })],
    ["a field value too long", crashpadForm({ _version: "1".repeat(LIMITS.formValue + 1) })],
  ])("refuses %s with 400", async (_label, form) => {
    const now = freshDay();
    expect((await handle(await postMinidump(form), testEnv(), now)).status).toBe(400);
    expect(await stored(now, "minidump")).toHaveLength(0);
  });

  it("refuses too many form fields", async () => {
    const form = crashpadForm();
    for (let index = 0; index < LIMITS.formFields; index += 1) form.append(`f${index}`, "x");
    expect((await handle(await postMinidump(form), testEnv(), freshDay())).status).toBe(400);
  });

  it("refuses a body that says gzip but is not", async () => {
    const request = await postMinidump(crashpadForm(), { compress: false });
    const lying = new Request(request, { headers: { ...Object.fromEntries(request.headers), "content-encoding": "gzip" } });
    expect((await handle(lying, testEnv(), freshDay())).status).toBe(400);
  });

  it("refuses another content type or encoding with 415", async () => {
    const plain = new Request(`${base}/minidump`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect((await handle(plain, testEnv(), freshDay())).status).toBe(415);
    const request = await postMinidump(crashpadForm());
    const brotli = new Request(request, { headers: { ...Object.fromEntries(request.headers), "content-encoding": "br" } });
    expect((await handle(brotli, testEnv(), freshDay())).status).toBe(415);
  });

  it("refuses an upload over the wire cap, and a small gzip that inflates past the inflated cap, with 413", async () => {
    const now = freshDay();
    const random = new Uint8Array(LIMITS.minidumpWireBytes + 1024);
    for (let offset = 0; offset < random.length; offset += 65_536)
      crypto.getRandomValues(random.subarray(offset, Math.min(offset + 65_536, random.length)));
    random.set(new TextEncoder().encode("MDMP"));
    expect((await handle(await postMinidump(crashpadForm({}, random), { compress: false }), testEnv(), now)).status).toBe(413);
    const bomb = await postMinidump(crashpadForm({}, minidump(LIMITS.minidumpBytes + 1024)));
    expect((await handle(bomb, testEnv(), now)).status).toBe(413);
    expect(await stored(now, "minidump")).toHaveLength(0);
  });
});
