import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { writeFileAtomic } from "../core/atomic-write";
import type { ErrorFields } from "../shared/error-fields";

/**
 * Crash reports, sent only while the student's crash-report switch is on (Settings > Privacy, and setup).
 *
 * Native crashes go through Electron's crashReporter (Crashpad), which main starts with `uploadToServer` set from the
 * switch. JavaScript errors from main, core and the window come here: each is scrubbed, deduplicated, counted against a
 * daily cap and queued in `userData/crash-reports.json`, then posted to the Worker in `crash-worker/`. An error raised
 * while the switch is off is dropped at once and never stored, so turning the switch on later cannot send it, and
 * turning it off empties the queue. See docs/crash-reports.md.
 */

export const CRASH_ENDPOINT = "https://pyxis-crash.tost100bar.workers.dev";

export const CRASH_LIMITS = {
  /** Reports accepted per UTC day, after deduplication. */
  perDay: 10,
  /** Errors looked at per minute; a loop that throws on every frame stops costing anything after this. */
  perMinute: 20,
  queueItems: 20,
  queueBytes: 200_000,
  /** Starts at which a queued report may fail to send before it is dropped. */
  attempts: 5,
  /** A queued report older than this is dropped unsent. */
  maxAgeMs: 14 * 86_400_000,
  messageChars: 300,
  stackFrames: 30,
  frameChars: 300,
  /** Fingerprints remembered per day. */
  seen: 200,
} as const;

export type ProcessKind = "main" | "core" | "renderer";

/** Exactly what leaves the computer for one JavaScript error. The Worker accepts these eight fields and no others. */
export type ErrorReport = {
  appVersion: string;
  electronVersion: string;
  os: "darwin" | "win32" | "linux";
  arch: "x64" | "arm64" | "ia32" | "arm";
  process: ProcessKind;
  name: string;
  message: string;
  stack: string;
};

export type ReportMeta = Pick<ErrorReport, "appVersion" | "electronVersion" | "os" | "arch">;

/** Folders whose paths never leave the computer. Each is replaced by its label wherever it appears. */
export type ScrubRoots = {
  /** The installed app: the asar, resources and the executable's folder. Code paths under it are kept. */
  app: string[];
  workspace: string;
  userData: string;
  home: string;
};

// Placeholders used while scrubbing. Control characters cannot come from the error text, which loses them first.
const MARK = {
  app: "\u0001A\u0001",
  workspace: "\u0001W\u0001",
  userData: "\u0001U\u0001",
  home: "\u0001H\u0001",
} as const;
const LABEL: Record<keyof typeof MARK, string> = {
  app: "<app>",
  workspace: "<workspace>",
  userData: "<userData>",
  home: "~",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A folder as it can appear in text: either slash, a doubled backslash from JSON, or a percent-encoded file URL. */
function variants(path: string): string[] {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed.length < 2) return [];
  const forward = trimmed.replace(/\\/g, "/");
  const back = trimmed.replace(/\//g, "\\");
  // file:///C:/Users/Mario%20Rossi or file:///home/mario; the "file://" before it is matched with the folder.
  const url = (/^[A-Za-z]:/.test(forward) ? `/${forward}` : forward)
    .split("/")
    .map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
  return [...new Set([trimmed, forward, back, back.replace(/\\/g, "\\\\"), url])].filter(
    (variant) => variant.length >= 2,
  );
}

function replaceRoots(text: string, roots: ScrubRoots): string {
  const entries: Array<[string, string]> = [];
  for (const path of roots.app) for (const variant of variants(path)) entries.push([variant, MARK.app]);
  for (const variant of variants(roots.workspace)) entries.push([variant, MARK.workspace]);
  for (const variant of variants(roots.userData)) entries.push([variant, MARK.userData]);
  for (const variant of variants(roots.home)) entries.push([variant, MARK.home]);
  // Longest first, so a workspace inside the home folder becomes <workspace>, not ~.
  entries.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [variant, mark] of entries) {
    // A folder name must end there: /home/ada must not turn /home/adam into ~m.
    const pattern = new RegExp(`(?:file://)?${escapeRegExp(variant)}(?=[\\\\/]|$|[^\\w.-])`, "gi");
    out = out.replace(pattern, mark);
  }
  return out;
}

const SECRETS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "<key>"],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g, "<key>"],
  [/\bBearer\s+[^\s"'`,;]+/gi, "Bearer <key>"],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, "<key>"],
  [/[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "<email>"],
];

function redactSecrets(text: string): string {
  return SECRETS.reduce((out, [pattern, label]) => out.replace(pattern, label), text);
}

function stripControl(text: string): string {
  // Control characters other than newline and tab carry nothing worth sending, and the placeholders use one.
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

const SAFE_QUOTED = /^(?:[A-Za-z_$][\w$.-]{0,40}|<(?:app|path|url|blob|key|email|workspace|userData)>)$/;

/**
 * One error message, made safe to send. Folder roots become labels and anything after the home, workspace or userData
 * label becomes "…", other absolute paths and URLs become <path> and <url>, keys and e-mail addresses go, and quoted
 * text is kept only when it looks like a code identifier: library messages quote input ("Unexpected token 'C',
 * "Ciao Mario" is not valid JSON"), and that input can be the student's.
 */
export function scrubMessage(message: string, roots: ScrubRoots): string {
  let out = replaceRoots(stripControl(message), roots);
  out = redactSecrets(out);
  // Under the app folder: code paths, kept up to the next space or quote.
  out = out.replace(new RegExp(`${escapeRegExp(MARK.app)}([^\\s"'\`]*)`, "g"), (_m, tail: string) =>
    `<app>${tail.replace(/\\/g, "/")}`,
  );
  // Under home, workspace or userData: file names, possibly with spaces, so everything up to a quote or line end goes.
  for (const key of ["workspace", "userData", "home"] as const)
    out = out.replace(new RegExp(`${escapeRegExp(MARK[key])}([\\\\/][^\\n"'\`]*)?`, "g"), (_m, tail?: string) =>
      tail ? `${LABEL[key]}/…` : LABEL[key],
    );
  out = out
    .replace(/\bfile:\/\/[^\s"'`]*/gi, "<path>")
    .replace(/\bhttps?:\/\/[^\s"'`]*/gi, "<url>")
    .replace(/\bpyxis-blob:[^\s"'`]*/gi, "<blob>")
    .replace(/\b[A-Za-z]:[\\/][^\n"'`]*/g, "<path>")
    .replace(/(^|[^\w\\])\\\\[^\\\s"'`]+\\[^\n"'`]*/g, "$1<path>")
    // A path can hold spaces, so it runs to a quote, a bracket or the line end.
    .replace(/(^|[\s(=,[:])\/[^\n"'`)\]]+/g, "$1<path>");
  const quoted: Array<[RegExp, string, string]> = [
    [/"([^"\n]*)"/g, '"', '"'],
    [/'([^'\n]*)'/g, "'", "'"],
    [/`([^`\n]*)`/g, "`", "`"],
    [/“([^”\n]*)”/g, "“", "”"],
    [/«([^»\n]*)»/g, "«", "»"],
  ];
  for (const [pattern, open, close] of quoted)
    out = out.replace(pattern, (_m, inner: string) => `${open}${SAFE_QUOTED.test(inner) ? inner : "…"}${close}`);
  out = out.replace(/\s+/g, " ").trim();
  return out.length > CRASH_LIMITS.messageChars ? `${out.slice(0, CRASH_LIMITS.messageChars - 1)}…` : out;
}

const KEPT_LOCATION =
  /^(?:node:|electron\/|electron:|pyxis-app:\/\/app\/|<anonymous>(?::\d+:\d+)?$|native$|index \d+$|internal\/|\[)/;

function scrubLocation(location: string, roots: ScrubRoots): string {
  let value = replaceRoots(location.trim(), roots);
  if (value.startsWith(MARK.app)) return `<app>${value.slice(MARK.app.length).replace(/\\/g, "/")}`;
  if (KEPT_LOCATION.test(value)) return value;
  if (/^https?:\/\//i.test(value)) return "<url>";
  // Anything else (a file elsewhere, a folder under home) keeps only its line and column.
  const position = /(:\d+(?::\d+)?)$/.exec(value)?.[1] ?? "";
  value = "<path>" + position;
  return value;
}

/** One V8 stack frame, made safe: the function name stays, the location keeps code paths only. */
function scrubFrame(line: string, roots: ScrubRoots): string {
  const frame = line.trim().replace(/^at\s+/, "");
  let out: string;
  const call = /^(.*?) \((.*)\)$/.exec(frame);
  if (call) {
    const [, fn = "", location = ""] = call;
    const inner = /^eval at .*, (.*)$/.exec(location);
    out = `${fn} (${inner ? `eval, ${scrubLocation(inner[1] ?? "", roots)}` : scrubLocation(location, roots)})`;
  } else out = scrubLocation(frame, roots);
  out = redactSecrets(stripControl(`at ${out}`));
  return out.length > CRASH_LIMITS.frameChars ? `${out.slice(0, CRASH_LIMITS.frameChars - 1)}…` : out;
}

/** The frames of a stack only: the first lines repeat the message, which `scrubMessage` handles. */
export function scrubStack(stack: string, roots: ScrubRoots): string {
  return stripControl(stack)
    .split("\n")
    .filter((line) => /^\s*at\s/.test(line))
    .slice(0, CRASH_LIMITS.stackFrames)
    .map((line) => scrubFrame(line, roots))
    .join("\n");
}

export function scrubName(name: string): string {
  return /^[A-Za-z_$][\w$]{0,63}$/.test(name) ? name : "Error";
}

/** Same grouping as the Worker's: process, name, message with numbers folded, and the top five frames. */
export function fingerprint(report: ErrorReport): string {
  const frames = report.stack.split("\n").slice(0, 5).join("\n");
  const message = report.message.replace(/\d+/g, "#");
  return createHash("sha256")
    .update([report.process, report.name, message, frames].join("\n"))
    .digest("hex")
    .slice(0, 16);
}

export function buildReport(kind: ProcessKind, raw: ErrorFields, meta: ReportMeta, roots: ScrubRoots): ErrorReport {
  return {
    ...meta,
    process: kind,
    name: scrubName(raw.name),
    message: scrubMessage(raw.message, roots),
    stack: scrubStack(raw.stack, roots),
  };
}

type Queued = { report: ErrorReport; fingerprint: string; createdAt: number; attempts: number };

type State = {
  /** `since`: when the switch last went on. Only reports created after it may be sent. */
  consent: { enabled: boolean; since: number | null };
  day: string;
  accepted: number;
  seen: string[];
  queue: Queued[];
};

function emptyState(): State {
  return { consent: { enabled: false, since: null }, day: "", accepted: 0, seen: [], queue: [] };
}

function isQueued(value: unknown): value is Queued {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Queued>;
  const report = item.report as Partial<ErrorReport> | undefined;
  return (
    typeof item.fingerprint === "string" &&
    typeof item.createdAt === "number" &&
    typeof item.attempts === "number" &&
    !!report &&
    ["appVersion", "electronVersion", "os", "arch", "process", "name", "message", "stack"].every(
      (key) => typeof report[key as keyof ErrorReport] === "string",
    )
  );
}

/** The saved state, or a fresh one with the switch off when the file is missing or damaged. */
function readState(file: string): State {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<State>;
    const consent = raw.consent;
    const enabled = consent?.enabled === true && typeof consent.since === "number";
    return {
      consent: { enabled, since: enabled ? (consent!.since as number) : null },
      day: typeof raw.day === "string" ? raw.day : "",
      accepted: typeof raw.accepted === "number" ? raw.accepted : 0,
      seen: Array.isArray(raw.seen) ? raw.seen.filter((item): item is string => typeof item === "string") : [],
      queue: enabled && Array.isArray(raw.queue) ? raw.queue.filter(isQueued) : [],
    };
  } catch {
    return emptyState();
  }
}

export type CrashReportsOptions = {
  /** `userData/crash-reports.json`. */
  file: string;
  /** Where reports go; null sends nothing (development builds, and tests that name no endpoint). */
  endpoint: string | null;
  meta: ReportMeta;
  roots: () => ScrubRoots;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
};

export class CrashReports {
  private state: State;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private flushing: Promise<void> | null = null;
  private again = false;
  /** A send failed this session: the queue waits for the next start. */
  private offline = false;
  private minute = { start: 0, count: 0 };

  constructor(private readonly options: CrashReportsOptions) {
    this.state = readState(options.file);
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  get enabled(): boolean {
    return this.state.consent.enabled;
  }

  /** When the switch last went on, or null while it is off. */
  get since(): number | null {
    return this.state.consent.since;
  }

  /** Reports waiting to be sent, oldest first. */
  get queued(): readonly ErrorReport[] {
    return this.state.queue.map((item) => item.report);
  }

  private save(): void {
    try {
      writeFileAtomic(this.options.file, JSON.stringify(this.state));
    } catch (error) {
      this.log(`pyxis: crash reports not saved (${(error as Error).message})`);
    }
  }

  /**
   * Records the switch as core read it from the profile. Off empties the queue: nothing created before may go later.
   * On starts a new consent period and sends what is waiting from earlier ones that were never turned off.
   */
  setConsent(enabled: boolean): void {
    const current = this.state.consent;
    if (enabled && !current.enabled) this.state.consent = { enabled: true, since: this.now() };
    else if (!enabled && (current.enabled || this.state.queue.length > 0)) {
      this.state.consent = { enabled: false, since: null };
      this.state.queue = [];
    } else return;
    this.save();
  }

  /**
   * Scrubs one error and queues it, then sends the queue. Returns whether the error was kept. With the switch off it
   * returns at once, before reading the error.
   */
  capture(kind: ProcessKind, raw: ErrorFields): boolean {
    if (!this.state.consent.enabled) return false;
    const now = this.now();
    if (now - this.minute.start >= 60_000) this.minute = { start: now, count: 0 };
    this.minute.count += 1;
    if (this.minute.count > CRASH_LIMITS.perMinute) return false;
    const report = buildReport(kind, raw, this.options.meta, this.options.roots());
    const print = fingerprint(report);
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.state.day !== day) Object.assign(this.state, { day, accepted: 0, seen: [] });
    if (this.state.seen.includes(print) || this.state.accepted >= CRASH_LIMITS.perDay) return false;
    this.state.seen = [...this.state.seen, print].slice(-CRASH_LIMITS.seen);
    this.state.accepted += 1;
    const item: Queued = { report, fingerprint: print, createdAt: now, attempts: 0 };
    const bytes = JSON.stringify(this.state.queue).length + JSON.stringify(item).length;
    const fits = this.state.queue.length < CRASH_LIMITS.queueItems && bytes <= CRASH_LIMITS.queueBytes;
    if (fits) this.state.queue = [...this.state.queue, item];
    this.save();
    if (fits) void this.flush();
    return fits;
  }

  /** Sends the queue in order. Runs one at a time; a failed send leaves the rest for the next start. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      do {
        this.again = false;
        await this.sendQueue();
      } while (this.again && !this.offline);
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private drop(item: Queued): void {
    this.state.queue = this.state.queue.filter((queued) => queued !== item);
    this.save();
  }

  private async sendQueue(): Promise<void> {
    const endpoint = this.options.endpoint;
    while (endpoint && !this.offline && this.state.consent.enabled) {
      const item = this.state.queue[0];
      if (!item) return;
      const since = this.state.consent.since ?? Infinity;
      if (item.createdAt < since || this.now() - item.createdAt > CRASH_LIMITS.maxAgeMs || item.attempts >= CRASH_LIMITS.attempts) {
        this.drop(item);
        continue;
      }
      let status = 0;
      try {
        const response = await this.fetcher(`${endpoint}/error`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(item.report),
          signal: AbortSignal.timeout(15_000),
        });
        status = response.status;
      } catch {
        status = 0;
      }
      // The switch went off, or the queue was emptied, while the request was out.
      if (!this.state.queue.includes(item)) continue;
      if (status >= 200 && status < 300) this.drop(item);
      else if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        // The Worker refused this report; sending it again would get the same answer.
        this.log(`pyxis: crash report refused (${status})`);
        this.drop(item);
      } else {
        item.attempts += 1;
        this.offline = true;
        this.save();
      }
    }
  }
}

/**
 * Deletes Crashpad minidumps that must never be sent: every one while the switch is off, and those written before the
 * switch last went on. Runs before the crash reporter starts, so Crashpad cannot pick an old dump up for upload.
 * Returns how many dumps went.
 */
export function discardUnconsentedDumps(crashDumps: string, since: number | null): number {
  let removed = 0;
  // pending, completed and new on macOS and Linux; reports on Windows.
  for (const folder of ["pending", "completed", "new", "reports"]) {
    const dir = join(crashDumps, folder);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".dmp")) continue;
      const path = join(dir, name);
      try {
        if (since !== null && statSync(path).mtimeMs >= since) continue;
        rmSync(path, { force: true });
        rmSync(join(dir, `${basename(name, ".dmp")}.meta`), { force: true });
        removed += 1;
      } catch {
        /* A dump Crashpad still holds goes at the next start. */
      }
    }
  }
  return removed;
}
