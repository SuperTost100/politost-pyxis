import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  callsOf,
  clearJobLogs,
  pruneJobLogs,
  EVENTS_SHOWN,
  flushDebugLog,
  JOB_LOG_MAX,
  readJobLog,
  redactText,
  redactValue,
  removeJobLog,
  setDebugLogRoot,
  setDebugOn,
  setRedact,
  startCall,
} from "./log";

beforeAll(async () => {
  // The engine module hands cli-funnel's redact over as it loads, as it does in the app.
  const { redact } = await import("../engine/funnel");
  setRedact(redact);
});

describe("redactText", () => {
  it("masks secret JSON fields, KEY=value pairs, auth headers and token-shaped values", () => {
    const text = [
      '{"api_key":"abc123","note":"kept"}',
      "OPENAI_API_KEY=sk-live-123 HOME=/home/x",
      "Authorization: Bearer eyJhbGciOi.payload.sig",
      "x-api-key: plain-key-value",
    ].join("\n");
    const out = redactText(text);
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("sk-live-123");
    expect(out).not.toContain("eyJhbGciOi");
    expect(out).not.toContain("plain-key-value");
    expect(out).toContain('"note":"kept"');
    expect(out).toContain("HOME=/home/x");
  });

  it("masks the secrets it is given wherever they appear", () => {
    expect(redactText("the key is hunter2-long-secret here", ["hunter2-long-secret"])).not.toContain("hunter2");
  });
});

describe("redactValue", () => {
  it("masks fields named like secrets and every value under env and headers, and walks arrays", () => {
    expect(
      redactValue({
        token: "t-1",
        env: { PATH: "/bin" },
        headers: { accept: "json" },
        list: [{ password: "p" }, "Authorization: Bearer abc.def.ghi"],
        model: "sonnet",
      }),
    ).toEqual({
      token: "[redacted]",
      env: { PATH: "[redacted]" },
      headers: { accept: "[redacted]" },
      list: [{ password: "[redacted]" }, "Authorization: [redacted]"],
      model: "sonnet",
    });
  });
});

describe("job log", () => {
  let root: string;
  const job = "0190c8a2-0000-7000-8000-000000000001";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pyxis-debug-"));
    setDebugLogRoot(root);
    setDebugOn(true);
  });
  afterEach(() => {
    setDebugOn(false);
    setDebugLogRoot("");
    rmSync(root, { recursive: true, force: true });
  });

  it("writes a call, its events without the streamed text, and its end, masked, and reads them back", async () => {
    const call = startCall(job, {
      provider: "claude",
      model: "sonnet",
      access: "subscription",
      kind: "lesson",
      prompt: "Explain motion. OPENAI_API_KEY=sk-secret-1",
    });
    expect(call).not.toBeNull();
    call!.event({ type: "text.delta", text: "partial" } as { type: string });
    call!.event({ type: "raw", source: "stderr", data: "Authorization: Bearer abc.def.ghi" } as { type: string });
    call!.end({ text: "Motion is change of position.", finishReason: "stop", inputTokens: 10, outputTokens: 5 });
    const log = await readJobLog(job);
    expect(log?.lines.map((line) => line.type)).toEqual(["call", "event", "end"]);
    expect(log?.text).not.toContain("sk-secret-1");
    expect(log?.text).not.toContain("abc.def.ghi");
    expect(log?.text).not.toContain("partial");
    const end = log!.lines[2] as { ms: number; text: string; textLength: number };
    expect(end.text).toBe("Motion is change of position.");
    expect(end.textLength).toBe(29);
    expect(end.ms).toBeGreaterThanOrEqual(0);
    // The file is readable by this user only.
    if (process.platform !== "win32")
      expect(statSync(join(root, "jobs", `${job}.jsonl`)).mode & 0o777).toBe(0o600);
  });

  it("writes nothing while debug mode is off, outside a job, or for an id that is not a job id", async () => {
    setDebugOn(false);
    expect(startCall(job, { provider: "claude", model: "m", access: "subscription", prompt: "p" })).toBeNull();
    setDebugOn(true);
    expect(startCall(undefined, { provider: "claude", model: "m", access: "subscription", prompt: "p" })).toBeNull();
    startCall("../escape", { provider: "claude", model: "m", access: "subscription", prompt: "p" })?.end({ text: "" });
    await flushDebugLog();
    expect(await readJobLog(job)).toBeNull();
    expect(await readJobLog("../escape")).toBeNull();
  });

  it("stops at the size cap with one capped line", async () => {
    mkdirSync(join(root, "jobs"), { recursive: true });
    const file = join(root, "jobs", `${job}.jsonl`);
    writeFileSync(file, `${"x".repeat(JOB_LOG_MAX - 10)}\n`);
    startCall(job, { provider: "claude", model: "m", access: "subscription", prompt: "p" })!.end({ text: "done" });
    await flushDebugLog();
    const tail = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(1);
    expect(tail.map((line) => JSON.parse(line).type)).toEqual(["log.capped"]);
  });

  it("prunes the logs of jobs that are gone, and clears them all when debug mode goes off", async () => {
    const other = "0190c8a2-0000-7000-8000-000000000002";
    for (const id of [job, other]) startCall(id, { provider: "claude", model: "m", access: "subscription", prompt: "p" })!.end({ text: "" });
    await flushDebugLog();
    await pruneJobLogs((id) => id === job);
    expect(await readJobLog(job)).not.toBeNull();
    expect(await readJobLog(other)).toBeNull();
    await clearJobLogs();
    expect(await readJobLog(job)).toBeNull();
  });

  it("drops the end of a call that was still running when debug mode went off", async () => {
    const call = startCall(job, { provider: "claude", model: "m", access: "subscription", prompt: "p" })!;
    setDebugOn(false);
    await clearJobLogs();
    call.end({ text: "a reply after the switch went off" });
    await flushDebugLog();
    expect(await readJobLog(job)).toBeNull();
  });

  it("deletes a job's log", async () => {
    startCall(job, { provider: "claude", model: "m", access: "subscription", prompt: "p" })!.end({ text: "" });
    await removeJobLog(job);
    expect(await readJobLog(job)).toBeNull();
  });
});

describe("callsOf", () => {
  it("folds lines into calls with their end, keeps a running call open and caps the events it carries", () => {
    const at = "2026-11-06T10:00:00.000Z";
    const events = Array.from({ length: EVENTS_SHOWN + 5 }, () => ({ type: "event" as const, at, id: "a", event: { type: "raw" } }));
    const { calls, capped } = callsOf([
      { type: "call", at, id: "a", provider: "claude", model: "sonnet", access: "subscription", prompt: "p1" },
      ...events,
      { type: "end", at, id: "a", ms: 1200, text: "done", textLength: 4, finishReason: "stop" },
      { type: "call", at, id: "b", provider: "anthropic-api", model: "haiku", access: "api-key", prompt: "p2" },
      { type: "end", at, id: "orphan", ms: 1, text: "", textLength: 0 },
      { type: "log.capped", at, bytes: 10 },
    ]);
    expect(capped).toBe(true);
    expect(calls.map((call) => [call.id, call.ms, call.text])).toEqual([
      ["a", 1200, "done"],
      ["b", null, null],
    ]);
    expect(calls[0]!.events).toHaveLength(EVENTS_SHOWN);
    expect(calls[0]!.eventCount).toBe(EVENTS_SHOWN + 5);
  });
});
