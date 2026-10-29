import { mkdirSync, readFileSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../core/test-temp";
import { errorFields } from "../shared/error-fields";
import {
  CRASH_LIMITS,
  CrashReports,
  discardUnconsentedDumps,
  fingerprint,
  scrubMessage,
  scrubStack,
  buildReport,
  type ScrubRoots,
} from "./crash-reports";

const posix: ScrubRoots = {
  app: ["/opt/PoliTost Pyxis/resources/app.asar", "/opt/PoliTost Pyxis/resources", "/opt/PoliTost Pyxis"],
  workspace: "/home/mario/.config/politost-pyxis/workspace",
  userData: "/home/mario/.config/politost-pyxis",
  home: "/home/mario",
};

const windows: ScrubRoots = {
  app: ["C:\\Users\\Mario Rossi\\AppData\\Local\\Programs\\PoliTost Pyxis\\resources\\app.asar"],
  workspace: "D:\\Studio\\Pyxis",
  userData: "C:\\Users\\Mario Rossi\\AppData\\Roaming\\politost-pyxis",
  home: "C:\\Users\\Mario Rossi",
};

const meta = { appVersion: "0.4.1", electronVersion: "44.9.3", os: "linux", arch: "x64" } as const;

describe("scrubbing", () => {
  it("replaces the home, workspace and userData folders and drops what follows them", () => {
    expect(scrubMessage("open /home/mario/Documenti/Appunti di fisica.pdf failed", posix)).toBe("open ~/…");
    expect(scrubMessage("db at /home/mario/.config/politost-pyxis/workspace/pyxis.db is locked", posix)).toBe(
      "db at <workspace>/…",
    );
    expect(scrubMessage("config /home/mario/.config/politost-pyxis/config.json", posix)).toBe("config <userData>/…");
    expect(scrubMessage("home is /home/mario", posix)).toBe("home is ~");
    // A longer name that only starts like the home folder is another path, not the home folder.
    expect(scrubMessage("open /home/marioX/notes.txt", posix)).toBe("open <path>");
  });

  it("handles Windows paths in any slash style, case and as a file URL", () => {
    expect(scrubMessage("EPERM C:\\Users\\Mario Rossi\\Desktop\\tesi.docx", windows)).toBe("EPERM ~/…");
    expect(scrubMessage("EPERM c:/users/mario rossi/Desktop/tesi.docx", windows)).toBe("EPERM ~/…");
    expect(scrubMessage("in D:\\\\Studio\\\\Pyxis\\\\blobs", windows)).toBe("in <workspace>/…");
    expect(scrubMessage("load file:///C:/Users/Mario%20Rossi/Desktop/x.pdf", windows)).toBe("load ~/…");
    expect(scrubMessage("open E:\\Chiavetta\\Esame di Mario.pdf", windows)).toBe("open <path>");
    expect(scrubMessage("share \\\\server\\scuola\\mario.pdf", windows)).toBe("share <path>");
  });

  it("keeps code paths under the app and replaces other absolute paths, URLs and blobs", () => {
    expect(scrubMessage("bad module /opt/PoliTost Pyxis/resources/app.asar/out/main/core.js", posix)).toBe(
      "bad module <app>/out/main/core.js",
    );
    expect(scrubMessage("ENOENT /media/usb/Esame Mario.pdf", posix)).toBe("ENOENT <path>");
    expect(scrubMessage("fetch https://example.com/appunti?id=mario failed", posix)).toBe("fetch <url> failed");
    expect(scrubMessage("no pyxis-blob://blob/ab12cd", posix)).toBe("no <blob>");
  });

  it("drops quoted input but keeps quoted identifiers", () => {
    expect(scrubMessage(`Unexpected token 'C', "Ciao Mario, ecco i miei appunti" is not valid JSON`, posix)).toBe(
      `Unexpected token 'C', "…" is not valid JSON`,
    );
    expect(scrubMessage("Cannot read properties of undefined (reading 'readFile')", posix)).toBe(
      "Cannot read properties of undefined (reading 'readFile')",
    );
    expect(scrubMessage("ENOENT: no such file or directory, open '/home/mario/My Notes/x.pdf'", posix)).toBe(
      "ENOENT: no such file or directory, open '…'",
    );
    expect(scrubMessage("model said «la risposta è 42»", posix)).toBe("model said «…»");
  });

  it("drops a quoted single word unless it is clearly code, so a name typed by the student never goes", () => {
    for (const word of ["Mario", "mario", "ciao", "Rossi", "length"])
      expect(scrubMessage(`Unknown value '${word}'`, posix)).toBe("Unknown value '…'");
    for (const word of ["C", "readFile", "plan_id", "fs.promises", "ENOENT", "item2", "$scope", "undefined", "null"])
      expect(scrubMessage(`Unknown value '${word}'`, posix)).toBe(`Unknown value '${word}'`);
  });

  it("removes API keys, tokens and e-mail addresses", () => {
    const message = scrubMessage(
      "401 for sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 and sk-proj-ABCDEFGHIJKLMNOP1234, Bearer abc.def, mario.rossi@studenti.polito.it",
      posix,
    );
    expect(message).toBe("401 for <key> and <key>, Bearer <key>, <email>");
    expect(scrubMessage("token ghp_abcdefghijklmnopqrstuvwxyz123456", posix)).toBe("token <key>");
  });

  it("caps the message and folds it onto one line", () => {
    const message = scrubMessage(`first line\n${"x ".repeat(400)}`, posix);
    expect(message.length).toBe(CRASH_LIMITS.messageChars);
    expect(message).not.toContain("\n");
    expect(message.endsWith("…")).toBe(true);
  });

  it("keeps stack frames only, with code locations and without other paths", () => {
    const stack = [
      "Error: open '/home/mario/Appunti.pdf' failed",
      "with a second message line about Mario",
      "    at readSource (/opt/PoliTost Pyxis/resources/app.asar/out/main/core.js:120:15)",
      "    at async Promise.all (index 0)",
      "    at Object.<anonymous> (/home/mario/Scrivania/script.js:3:9)",
      "    at render (pyxis-app://app/assets/index-abc123.js:1:2345)",
      "    at node:internal/fs/promises:638:25",
      "    at eval (eval at load (/opt/PoliTost Pyxis/resources/app.asar/out/main/core.js:9:1), <anonymous>:1:1)",
      "    at http://localhost:5173/src/main.tsx:4:2",
    ].join("\n");
    expect(scrubStack(stack, posix).split("\n")).toEqual([
      "at readSource (<app>/out/main/core.js:120:15)",
      "at async Promise.all (index 0)",
      "at Object.<anonymous> (<path>:3:9)",
      "at render (pyxis-app://app/assets/index-abc123.js:1:2345)",
      "at node:internal/fs/promises:638:25",
      "at eval (eval, <anonymous>:1:1)",
      "at <url>",
    ]);
  });

  it("keeps at most 30 frames", () => {
    const stack = Array.from({ length: 50 }, (_, index) => `    at f${index} (node:internal/x:1:1)`).join("\n");
    expect(scrubStack(stack, posix).split("\n")).toHaveLength(CRASH_LIMITS.stackFrames);
  });

  it("builds a report of exactly the eight fields, with a safe name", () => {
    const report = buildReport("core", { name: "Error: Mario", message: "x", stack: "" }, meta, posix);
    expect(Object.keys(report).sort()).toEqual(
      ["appVersion", "arch", "electronVersion", "message", "name", "os", "process", "stack"].sort(),
    );
    expect(report.name).toBe("Error");
    expect(buildReport("core", { name: "TypeError", message: "", stack: "" }, meta, posix).name).toBe("TypeError");
  });

  it("gives the same fingerprint when only numbers in the message differ", () => {
    const one = buildReport("main", { name: "RangeError", message: "index 3", stack: "at f (node:x:1:1)" }, meta, posix);
    const two = buildReport("main", { name: "RangeError", message: "index 70", stack: "at f (node:x:1:1)" }, meta, posix);
    const other = buildReport("core", { name: "RangeError", message: "index 3", stack: "at f (node:x:1:1)" }, meta, posix);
    expect(fingerprint(one)).toBe(fingerprint(two));
    expect(fingerprint(one)).not.toBe(fingerprint(other));
  });

  it("reads only name, message and stack from a thrown value, and only the type or code from a non-Error", () => {
    const error = new TypeError("boom");
    expect(errorFields(error)).toMatchObject({ name: "TypeError", message: "boom" });
    expect(errorFields("my notes on Dante")).toEqual({ name: "NonError", message: "string", stack: "" });
    expect(errorFields({ code: "core-restarted", detail: "chat text" })).toEqual({
      name: "NonError",
      message: "core-restarted",
      stack: "",
    });
    expect(errorFields({ code: "Not A Code", detail: "x" }).message).toBe("object");
    expect(errorFields(null).message).toBe("null");
    const hostile = { get stack(): string { throw new Error("no"); }, message: "m" };
    expect(errorFields(hostile)).toEqual({ name: "Error", message: "unreadable", stack: "" });
  });
});

type Sent = { url: string; body: Record<string, unknown> };

function harness(options: { status?: number | "offline"; endpoint?: string | null; start?: number } = {}) {
  const dir = tempDir("pyxis-crash-");
  const file = join(dir, "crash-reports.json");
  const sent: Sent[] = [];
  let clock = options.start ?? Date.UTC(2026, 9, 28, 10);
  let status = options.status ?? 204;
  const fetcher = (async (url: string, init: RequestInit) => {
    if (status === "offline") throw new TypeError("fetch failed");
    sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  const make = () =>
    new CrashReports({
      file,
      endpoint: options.endpoint === undefined ? "https://crash.test" : options.endpoint,
      meta,
      roots: () => posix,
      fetch: fetcher,
      now: () => clock,
      log: () => {},
    });
  return {
    file,
    sent,
    make,
    tick: (ms: number) => (clock += ms),
    setStatus: (next: number | "offline") => (status = next),
  };
}

const boom = (message = "boom", stack = "Error: boom\n    at f (node:internal/x:1:1)") => ({
  name: "Error",
  message,
  stack,
});

describe("consent", () => {
  it("starts off and sends nothing until the switch is on", async () => {
    const h = harness();
    const reports = h.make();
    expect(reports.enabled).toBe(false);
    expect(reports.capture("main", boom())).toBe(false);
    await reports.flush();
    expect(h.sent).toEqual([]);
    expect(existsSync(h.file)).toBe(false);
  });

  it("never sends an error raised while the switch was off, even after it is turned on", async () => {
    const h = harness();
    const reports = h.make();
    reports.capture("renderer", boom("created while off"));
    reports.setConsent(true);
    await reports.flush();
    expect(h.sent).toEqual([]);
    // Not kept on disk either: a later start has nothing to send.
    expect(readFileSync(h.file, "utf8")).not.toContain("created while off");
    const next = h.make();
    await next.flush();
    expect(h.sent).toEqual([]);
  });

  it("sends a scrubbed report while on, to the error route, and nothing beyond the eight fields", async () => {
    const h = harness();
    const reports = h.make();
    reports.setConsent(true);
    expect(reports.capture("core", boom("open /home/mario/Tesi.pdf failed"))).toBe(true);
    await reports.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.url).toBe("https://crash.test/error");
    expect(h.sent[0]!.body).toEqual({
      ...meta,
      process: "core",
      name: "Error",
      message: "open ~/…",
      stack: "at f (node:internal/x:1:1)",
    });
    expect(reports.queued).toEqual([]);
  });

  it("turning the switch off empties the queue, and turning it on again does not bring it back", async () => {
    const h = harness({ status: "offline" });
    const reports = h.make();
    reports.setConsent(true);
    reports.capture("main", boom("waiting offline"));
    await reports.flush();
    expect(reports.queued).toHaveLength(1);
    reports.setConsent(false);
    expect(reports.queued).toEqual([]);
    expect(readFileSync(h.file, "utf8")).not.toContain("waiting offline");
    h.setStatus(204);
    reports.setConsent(true);
    const next = h.make();
    next.setConsent(true);
    await next.flush();
    expect(h.sent).toEqual([]);
  });

  it("drops a queued report older than the current consent period", async () => {
    const h = harness({ status: "offline" });
    const reports = h.make();
    reports.setConsent(true);
    reports.capture("main", boom("from an earlier period"));
    await reports.flush();
    // The file is edited by hand (or a clock jumps) so that the report predates the period.
    const saved = JSON.parse(readFileSync(h.file, "utf8")) as { queue: Array<{ createdAt: number }> };
    saved.queue[0]!.createdAt = reports.since! - 1;
    writeFileSync(h.file, JSON.stringify(saved));
    h.setStatus(204);
    const next = h.make();
    next.setConsent(true);
    await next.flush();
    expect(h.sent).toEqual([]);
    expect(next.queued).toEqual([]);
  });

  it("treats a damaged state file as off", () => {
    const h = harness();
    writeFileSync(h.file, "{not json");
    expect(h.make().enabled).toBe(false);
    writeFileSync(h.file, JSON.stringify({ consent: { enabled: true } }));
    expect(h.make().enabled).toBe(false);
  });

  it("sends nothing without an endpoint", async () => {
    const h = harness({ endpoint: null });
    const reports = h.make();
    reports.setConsent(true);
    reports.capture("main", boom());
    await reports.flush();
    expect(h.sent).toEqual([]);
  });
});

describe("waiting for core", () => {
  /** A profile whose saved copy says on: an earlier session where core confirmed the switch. */
  async function onFromEarlierSession(h: ReturnType<typeof harness>) {
    const earlier = h.make();
    earlier.setConsent(true);
    h.setStatus("offline");
    earlier.capture("main", boom("queued earlier"));
    await earlier.flush();
    h.setStatus(204);
    h.tick(60_000);
  }

  it("sends nothing, and writes no new report, until core has confirmed the switch", async () => {
    const h = harness();
    await onFromEarlierSession(h);
    const before = readFileSync(h.file, "utf8");
    const reports = h.make();
    expect(reports.enabled).toBe(true);
    reports.capture("main", boom("before core is up"));
    await reports.flush();
    expect(h.sent).toEqual([]);
    expect(readFileSync(h.file, "utf8")).toBe(before);
  });

  it("sends the held report and the earlier queue once core says on", async () => {
    const h = harness();
    await onFromEarlierSession(h);
    const reports = h.make();
    reports.capture("main", boom("before core is up"));
    reports.setConsent(true);
    await reports.flush();
    expect(h.sent.map((item) => item.body["message"]).sort()).toEqual(["before core is up", "queued earlier"]);
  });

  it("drops the held report and the earlier queue once core says off", async () => {
    const h = harness();
    await onFromEarlierSession(h);
    const reports = h.make();
    reports.capture("main", boom("before core is up"));
    reports.setConsent(false);
    await reports.flush();
    reports.setConsent(true);
    await reports.flush();
    expect(h.sent).toEqual([]);
    expect(readFileSync(h.file, "utf8")).not.toContain("before core is up");
    expect(readFileSync(h.file, "utf8")).not.toContain("queued earlier");
  });

  it("holds nothing while the saved copy says off, even if core then says on", async () => {
    const h = harness();
    const reports = h.make();
    reports.capture("main", boom("before core is up"));
    reports.setConsent(true);
    await reports.flush();
    expect(h.sent).toEqual([]);
  });
});

describe("dedupe and caps", () => {
  it("sends the same error once a day, and again the next day", async () => {
    const h = harness();
    const reports = h.make();
    reports.setConsent(true);
    expect(reports.capture("renderer", boom("index 3"))).toBe(true);
    expect(reports.capture("renderer", boom("index 4"))).toBe(false);
    await reports.flush();
    expect(h.sent).toHaveLength(1);
    h.tick(86_400_000);
    expect(reports.capture("renderer", boom("index 5"))).toBe(true);
    await reports.flush();
    expect(h.sent).toHaveLength(2);
  });

  it("remembers what it sent across a restart", async () => {
    const h = harness();
    const reports = h.make();
    reports.setConsent(true);
    reports.capture("main", boom());
    await reports.flush();
    const next = h.make();
    next.setConsent(true);
    expect(next.capture("main", boom())).toBe(false);
  });

  it(`accepts at most ${CRASH_LIMITS.perDay} different errors a day`, async () => {
    const h = harness();
    const reports = h.make();
    reports.setConsent(true);
    const kept = Array.from({ length: CRASH_LIMITS.perDay + 5 }, (_, index) => {
      h.tick(10_000);
      return reports.capture("main", boom(`error kind ${"x".repeat(index)}`));
    });
    expect(kept.filter(Boolean)).toHaveLength(CRASH_LIMITS.perDay);
    await reports.flush();
    expect(h.sent).toHaveLength(CRASH_LIMITS.perDay);
  });

  it(`looks at most at ${CRASH_LIMITS.perMinute} errors a minute`, () => {
    const h = harness({ status: "offline" });
    const reports = h.make();
    reports.setConsent(true);
    const looked = Array.from({ length: CRASH_LIMITS.perMinute }, () => reports.capture("main", boom()));
    // The first is kept, the rest are duplicates; each still counts against the minute.
    expect(looked.filter(Boolean)).toHaveLength(1);
    expect(reports.capture("main", boom("a new one"))).toBe(false);
    h.tick(61_000);
    expect(reports.capture("main", boom("a new one"))).toBe(true);
  });
});

describe("queue", () => {
  it("keeps a report that could not be sent and sends it at the next start", async () => {
    const h = harness({ status: "offline" });
    const reports = h.make();
    reports.setConsent(true);
    reports.capture("core", boom("sent later"));
    await reports.flush();
    expect(reports.queued).toHaveLength(1);
    // A second error in the same session does not try the network again.
    reports.capture("core", boom("also later"));
    await reports.flush();
    expect(h.sent).toEqual([]);
    h.setStatus(204);
    h.tick(3_600_000);
    const next = h.make();
    expect(next.queued).toHaveLength(2);
    next.setConsent(true);
    await next.flush();
    expect(h.sent.map((item) => item.body["message"])).toEqual(["sent later", "also later"]);
    expect(next.queued).toEqual([]);
  });

  it("retries a server error and a rate limit, but drops a report the Worker refuses", async () => {
    for (const [status, kept] of [
      [500, 1],
      [429, 1],
      [400, 0],
      [413, 0],
    ] as const) {
      const h = harness({ status });
      const reports = h.make();
      reports.setConsent(true);
      reports.capture("main", boom());
      await reports.flush();
      expect(reports.queued, `status ${status}`).toHaveLength(kept);
    }
  });

  it(`gives up on a report after ${CRASH_LIMITS.attempts} failed starts`, async () => {
    const h = harness({ status: 503 });
    let reports = h.make();
    reports.setConsent(true);
    reports.capture("main", boom());
    await reports.flush();
    for (let start = 1; start <= CRASH_LIMITS.attempts; start += 1) {
      reports = h.make();
      reports.setConsent(true);
      await reports.flush();
    }
    expect(reports.queued).toEqual([]);
  });

  it("drops a report older than two weeks unsent", async () => {
    const h = harness({ status: "offline" });
    const reports = h.make();
    reports.setConsent(true);
    reports.capture("main", boom());
    await reports.flush();
    h.setStatus(204);
    h.tick(CRASH_LIMITS.maxAgeMs + 1);
    const next = h.make();
    next.setConsent(true);
    await next.flush();
    expect(h.sent).toEqual([]);
    expect(next.queued).toEqual([]);
  });

  it(`holds at most ${CRASH_LIMITS.queueItems} reports and ${CRASH_LIMITS.queueBytes} bytes`, async () => {
    const h = harness({ status: "offline" });
    const reports = h.make();
    reports.setConsent(true);
    for (let day = 0; day < 5; day += 1) {
      for (let index = 0; index < CRASH_LIMITS.perDay; index += 1) {
        h.tick(4_000);
        reports.capture("main", boom(`day ${"d".repeat(day)} error ${"e".repeat(index)}`, `Error\n${"    at f (node:x:1:1)\n".repeat(30)}`));
      }
      h.tick(86_400_000);
    }
    expect(reports.queued).toHaveLength(CRASH_LIMITS.queueItems);
    expect(readFileSync(h.file, "utf8").length).toBeLessThan(CRASH_LIMITS.queueBytes + 2_000);
  });

  it("aborts the request in flight when the switch goes off, and drops its report", async () => {
    const dir = tempDir("pyxis-crash-");
    let signal: AbortSignal | undefined;
    let started: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    const reports = new CrashReports({
      file: join(dir, "crash-reports.json"),
      endpoint: "https://crash.test",
      meta,
      roots: () => posix,
      // Answers only when its request is aborted, as a stalled connection would.
      fetch: ((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        started();
        return new Promise<Response>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal?.reason)),
        );
      }) as unknown as typeof fetch,
      log: () => {},
    });
    reports.setConsent(true);
    reports.capture("main", boom("in flight"));
    const flushing = reports.flush();
    await inFlight;
    expect(signal?.aborted).toBe(false);
    reports.setConsent(false);
    expect(signal?.aborted).toBe(true);
    await flushing;
    expect(reports.queued).toEqual([]);
    expect(readFileSync(join(dir, "crash-reports.json"), "utf8")).not.toContain("in flight");
    // Turned on again, nothing comes back to send.
    reports.setConsent(true);
    await reports.flush();
    expect(reports.queued).toEqual([]);
  });

  it("does not send a report whose queue was emptied while its request was out", async () => {
    const dir = tempDir("pyxis-crash-");
    let release: (value: Response) => void = () => {};
    const reports = new CrashReports({
      file: join(dir, "crash-reports.json"),
      endpoint: "https://crash.test",
      meta,
      roots: () => posix,
      fetch: (() => new Promise<Response>((resolve) => (release = resolve))) as unknown as typeof fetch,
      log: () => {},
    });
    reports.setConsent(true);
    reports.capture("main", boom());
    const flushing = reports.flush();
    reports.setConsent(false);
    release(new Response(null, { status: 500 }));
    await flushing;
    expect(reports.queued).toEqual([]);
    expect(readFileSync(join(dir, "crash-reports.json"), "utf8")).not.toContain("boom");
  });
});

describe("Crashpad dumps", () => {
  function crashpad(): { dir: string; dump: (folder: string, name: string, at: number) => string } {
    const dir = tempDir("pyxis-crashpad-");
    return {
      dir,
      dump(folder, name, at) {
        mkdirSync(join(dir, folder), { recursive: true });
        const path = join(dir, folder, `${name}.dmp`);
        writeFileSync(path, "MDMP");
        writeFileSync(join(dir, folder, `${name}.meta`), "meta");
        utimesSync(path, at / 1000, at / 1000);
        return path;
      },
    };
  }

  it("deletes every dump while the switch is off", () => {
    const { dir, dump } = crashpad();
    const paths = [dump("pending", "a", 1_000_000), dump("completed", "b", 2_000_000), dump("reports", "c", 3_000_000)];
    expect(discardUnconsentedDumps(dir, null)).toBe(3);
    for (const path of paths) {
      expect(existsSync(path)).toBe(false);
      expect(existsSync(path.replace(/\.dmp$/, ".meta"))).toBe(false);
    }
  });

  it("keeps dumps written since the switch went on and deletes older ones", () => {
    const { dir, dump } = crashpad();
    const since = Date.UTC(2026, 9, 1);
    const before = dump("pending", "before", since - 60_000);
    const after = dump("pending", "after", since + 60_000);
    expect(discardUnconsentedDumps(dir, since)).toBe(1);
    expect(existsSync(before)).toBe(false);
    expect(existsSync(after)).toBe(true);
  });

  it("does nothing without a Crashpad folder", () => {
    expect(discardUnconsentedDumps(join(tempDir("pyxis-crashpad-"), "missing"), null)).toBe(0);
  });
});
