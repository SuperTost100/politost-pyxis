import type Database from "better-sqlite3";
import { automaticEffort, studentEffort } from "../../shared/effort";
import { engineProviders, IpcError } from "../../shared/ipc";
import { autoFeatures, planAuto, type AutoProvider } from "./auto";
import {
  capabilityWarning,
  providerSeesImages,
  type Need,
} from "./capabilities";
import { translateEngineError } from "./errors";
import {
  acknowledgeProviders,
  endConversations,
  getFunnel,
  isProviderAcknowledged,
  providerName,
  runTurn,
  shellPathReady,
  type ProviderId,
} from "./funnel";
import { clearSignOut } from "./bench";
import { effortsOf, rememberModels, resolveEffort } from "./efforts";
import { isInstallable, runInstaller } from "./install";
import {
  rememberReady,
  withoutRefusedModels,
  type StoredSelection,
} from "./selection";
import { hardware as probeHardware, type Hardware } from "./hardware";
import {
  adviseLocal,
  checkLocalModel,
  LOCAL_PROVIDER,
  localData,
  localUsable,
  pullLocalModel,
  readLocal,
  tierOf,
  writeLocal,
  type LocalCheck,
  type LocalSettings,
} from "./local";
import { usageSince } from "./usage";

const features = [
  "default",
  "chat",
  "plan",
  "lesson",
  "grading",
  "map",
  "vision",
  "cards",
] as const;
const providers = new Set<string>(engineProviders);

export type LoginNotice = {
  provider: string;
  type: string;
  url?: string;
  /** The CLI opened `url` itself, so the app shows it as a link instead of opening it again. */
  opened?: boolean;
  message?: string;
  command?: string[];
};

function notice(
  provider: string,
  event: {
    type: string;
    url?: string;
    opened?: boolean;
    message?: string;
    command?: string[];
  },
): LoginNotice {
  return {
    provider,
    type: event.type,
    url: "url" in event ? event.url : undefined,
    opened: "opened" in event ? event.opened === true : undefined,
    message: "message" in event ? event.message : undefined,
    command: "command" in event ? event.command : undefined,
  };
}

const installs = new Map<
  string,
  { promise: Promise<{ ok: true }>; abort: AbortController }
>();

const loginSessions = new Map<
  string,
  { sendCode: (code: string) => void; cancel: () => void }
>();

function kindOf(id: string): "cli" | "api" {
  return id.endsWith("-api") ? "api" : "cli";
}

/** A CLI runs only when its adapter enforces text-only access. API providers and Ollama have no machine access. */
function textOnly(id: string, access: readonly string[] = []): boolean {
  return (
    kindOf(id) === "api" || id === LOCAL_PROVIDER || access.includes("none")
  );
}

/** How long Test waits for the one-word answer. A CLI that starts cold can take half a minute. */
const TEST_DEADLINE_MS = 90_000;

const invalidSelection = () => new IpcError("invalid-selection", "engines.errors.invalid-selection");

/** CLIs with no sign-out command: CLI Funnel throws "unsupported" for them, so the student signs out in the program itself. */
const NO_SIGN_OUT = new Set(["antigravity"]);

function disabled(id: string): boolean {
  const provider = getFunnel().providers[id as ProviderId];
  return !provider || !textOnly(id, provider.capabilities.access);
}

type OverviewRow = {
  id: string;
  name: string;
  kind: "cli" | "api";
  installed: boolean;
  loggedIn: boolean;
  disabled: boolean;
  version: string;
  path: string;
  withinTestedRange: boolean;
  acknowledged: boolean;
  capabilities: { effort: boolean; fast: boolean; signOut: boolean };
};

let scanning: Promise<OverviewRow[]> | null = null;

/** One provider scan at a time: the launch check, the automatic choice and the engine screen share a scan in progress. */
function overviewRows(): Promise<OverviewRow[]> {
  scanning ??= scanProviders().finally(() => {
    scanning = null;
  });
  return scanning;
}

async function scanProviders(): Promise<OverviewRow[]> {
  const rows = await readProviders();
  // An engine skipped after a sign-out is back once a scan finds it signed in.
  for (const row of rows) if (isReady(row)) clearSignOut(row.id);
  return rows;
}

async function readProviders(): Promise<OverviewRow[]> {
  // Detection looks for the CLIs on the login shell's PATH, which core reads in the background at launch.
  await shellPathReady();
  // CLI Funnel also lists providers Pyxis does not offer yet, such as Ollama.
  const rows = (await getFunnel().overview()).filter((row) =>
    providers.has(row.id),
  );
  return Promise.all(
    rows.map(async (row) => {
      let loggedIn = row.auth?.loggedIn ?? false;
      if (row.id.endsWith("-api") && loggedIn) {
        try {
          await getFunnel().models(row.id);
        } catch {
          loggedIn = false;
        }
      }
      return {
        id: row.id,
        name: row.displayName,
        kind: kindOf(row.id),
        installed: row.installation.installed,
        loggedIn,
        disabled: !textOnly(row.id, row.capabilities.access),
        version: row.installation.version ?? "",
        path: row.installation.path ?? "",
        withinTestedRange: row.installation.withinTestedRange ?? true,
        acknowledged: isProviderAcknowledged(row.id),
        capabilities: {
          effort: row.capabilities.effort,
          fast: row.capabilities.fast,
          signOut: !NO_SIGN_OUT.has(row.id),
        },
      };
    }),
  );
}

/** Installed, signed in (or keyed) and not switched off. */
function isReady(row: OverviewRow): boolean {
  return row.installed && row.loggedIn && !row.disabled;
}

type StoredRow = { feature: string; selection_json: string };

/**
 * Whether the last scan of a database found an engine to choose from. A sign-in probe that times out reads as
 * "signed out", so one scan that finds nothing after a good one is not trusted: the choices stay until a second
 * scan agrees. Signing out in Pyxis clears the flag, since that is certain.
 */
const hadEngines = new WeakMap<Database.Database, boolean>();

/**
 * Recomputes the automatic feature choices from the engines that are ready
 * now and acknowledged. An engine whose notice has not been read is never
 * chosen, so a task never reaches it. Features pinned by the student are left
 * alone, and no model is called.
 * `reset` un-pins the listed features (or all) before the plan is applied.
 */
export async function autoConfigureEngines(
  db: Database.Database,
  options: { reset?: boolean; features?: string[]; rows?: OverviewRow[] } = {},
): Promise<{ ready: string[]; features: Record<string, StoredSelection> }> {
  const rows = options.rows ?? (await overviewRows());
  const ready = rows.filter(isReady);
  const listed: AutoProvider[] = [];
  let failed = 0;
  for (const row of ready.filter((candidate) => candidate.acknowledged)) {
    try {
      const models = await getFunnel().models(row.id as ProviderId);
      rememberModels(row.id, models);
      listed.push({
        id: row.id,
        kind: row.kind,
        effort: row.capabilities.effort,
        images: providerSeesImages(row.id),
        models: models.map((model) => ({
          id: model.id,
          efforts: model.efforts,
        })),
      });
    } catch {
      failed += 1;
    }
  }
  const local = await localCandidate(db);
  if (local) listed.push(local);
  // A failed model listing is not proof that the engine went away. Keep the
  // current choices rather than blanking them.
  const unreadable = failed > 0 && listed.length === 0;
  // A task whose engine hits a usage limit switches to the next one from this list.
  if (!unreadable) rememberReady(listed);
  // A model the student's subscription refused today is left out, so the task moves to one that answers.
  const plan = planAuto(withoutRefusedModels(listed));
  const doubtful =
    !unreadable && listed.length === 0 && hadEngines.get(db) === true;
  if (!unreadable) hadEngines.set(db, listed.length > 0);
  const now = Date.now();
  const apply = db.transaction(() => {
    // A reset that cannot read any model list would leave every feature without an engine.
    if (unreadable || doubtful) return;
    const before = new Map(
      (
        db
          .prepare("SELECT feature, selection_json FROM feature_engines")
          .all() as StoredRow[]
      ).map((row) => [row.feature, JSON.parse(row.selection_json)]),
    ) as Map<string, StoredSelection>;
    // Handing one task back to Pyxis keeps the effort the student picked for it. Resetting everything does not.
    const keepsEffort = !options.reset || !!options.features?.length;
    if (options.reset) {
      const scope = options.features;
      if (scope?.length)
        for (const feature of scope)
          db.prepare("DELETE FROM feature_engines WHERE feature = ?").run(
            feature,
          );
      else db.prepare("DELETE FROM feature_engines").run();
    }
    const existing = new Map(
      (
        db
          .prepare("SELECT feature, selection_json FROM feature_engines")
          .all() as StoredRow[]
      ).map((row) => [row.feature, row.selection_json]),
    );
    for (const feature of autoFeatures) {
      const current = existing.get(feature);
      const pinned =
        current !== undefined &&
        (JSON.parse(current) as StoredSelection).auto !== true;
      if (pinned) continue;
      const choice = plan[feature];
      if (!choice) {
        if (current !== undefined)
          db.prepare("DELETE FROM feature_engines WHERE feature = ?").run(
            feature,
          );
        continue;
      }
      const picked = keepsEffort
        ? studentEffort(before.get(feature))
        : undefined;
      const efforts = listed
        .find((provider) => provider.id === choice.provider)
        ?.models.find((model) => model.id === choice.model)
        ?.efforts.map((option) => option.id);
      const next = JSON.stringify({
        ...choice,
        // The pick applies while the new model still lists it, and waits otherwise.
        ...(picked && efforts?.includes(picked) ? { effort: picked } : {}),
        auto: true,
        ...(picked ? { effortChoice: picked } : {}),
      });
      if (current !== undefined && current === next) continue;
      db.prepare(
        `INSERT INTO feature_engines (feature, selection_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(feature) DO UPDATE SET selection_json = excluded.selection_json, updated_at = excluded.updated_at`,
      ).run(feature, next, now);
    }
  });
  apply();
  return {
    ready: [...ready.map((row) => row.id), ...(local ? [local.id] : [])],
    features: readFeatures(db),
  };
}

/**
 * The local model as a candidate for the automatic choice: only the model Pyxis checked, only while the student has it
 * on, the check passed and Ollama still lists it. Other models in the student's Ollama are never chosen.
 */
async function localCandidate(
  db: Database.Database,
): Promise<AutoProvider | undefined> {
  const saved = readLocal(db);
  if (!localUsable(saved) || !isProviderAcknowledged(LOCAL_PROVIDER)) return;
  try {
    const models = await getFunnel().models(LOCAL_PROVIDER);
    const model = models.find((candidate) => candidate.id === saved!.model);
    if (!model) return;
    rememberModels(LOCAL_PROVIDER, models);
    return {
      id: LOCAL_PROVIDER,
      kind: "local",
      structured: saved!.check!.structured,
      effort: true,
      images: providerSeesImages(LOCAL_PROVIDER),
      models: [{ id: model.id, efforts: model.efforts }],
    };
  } catch {
    // Ollama is not running: the local model sits out until it is.
    return undefined;
  }
}

type LocalProgress = {
  phase: "pull" | "check";
  completed: number;
  total: number;
};
type LocalRun = {
  promise: Promise<LocalCheck>;
  abort: AbortController;
  progress: LocalProgress;
};

export type LocalEvent = {
  phase: "pull" | "check" | "done" | "failed" | "cancelled";
  status?: string;
  completed?: number;
  total?: number;
};

function readFeatures(db: Database.Database): Record<string, StoredSelection> {
  const rows = db
    .prepare(`SELECT feature, selection_json FROM feature_engines`)
    .all() as StoredRow[];
  return Object.fromEntries(
    rows.map((row) => [row.feature, JSON.parse(row.selection_json)]),
  );
}

export function engineHandlers(
  db: Database.Database,
  emit: (event: LoginNotice) => void,
  options: {
    auto?: boolean;
    onAuto?: () => void;
    /** Installer output, line by line, so setup can show progress. */
    onInstallLog?: (event: { provider: string; text: string }) => void;
    /** Tests run this script instead of the vendor installer. */
    installerFixture?: string;
    /** Download and check progress of the local model. */
    onLocal?: (event: LocalEvent) => void;
    /** Tests describe the computer instead of probing it. */
    hardware?: () => Promise<Hardware>;
  } = {},
) {
  const readHardware = options.hardware ?? probeHardware;
  // The download and check of the local model. One at a time; a second request waits for the same run.
  let localRun: LocalRun | null = null;
  let localStarting = false;
  let localLast: { outcome: "failed" | "cancelled"; detail: string } | null =
    null;
  function emitLocal(event: LocalEvent) {
    options.onLocal?.(event);
  }
  /** Records how a local download or check ended without a result and tells the screen. */
  function localStopped(err: unknown, abort: AbortController): { cancelled: boolean; detail: string } {
    const cancelled = abort.signal.aborted;
    const detail = cancelled ? "" : err instanceof Error ? err.message : String(err);
    localLast = { outcome: cancelled ? "cancelled" : "failed", detail };
    emitLocal({ phase: cancelled ? "cancelled" : "failed" });
    return { cancelled, detail };
  }
  /** Signing in, out and updating are for the subscription CLIs this build offers. */
  function requireCli(provider: ProviderId): void {
    if (!providers.has(provider) || disabled(provider) || provider.endsWith("-api"))
      throw new IpcError("unsupported", "engines.disabled");
  }
  async function localState() {
    const hw = await readHardware();
    const ollama = getFunnel().providers[LOCAL_PROVIDER];
    const installation = await ollama?.detect().catch(() => undefined);
    const running = installation?.installed === true;
    const downloaded = running
      ? (await ollama!.models().catch(() => [])).map((model) => model.id)
      : [];
    const advice = adviseLocal(hw, downloaded);
    const saved = readLocal(db);
    // A model the student downloaded or checked stays theirs. One saved by a pull that never finished follows the advice
    // for this computer as it is now, so more free space or a changed GPU is not hidden behind the old pick.
    const keepsSaved =
      !!saved &&
      (saved.check?.model === saved.model || downloaded.includes(saved.model));
    const id = keepsSaved ? saved.model : advice.tier?.model;
    const tier = id ? tierOf(id) : undefined;
    return {
      hardware: {
        ramBytes: hw.ramBytes,
        freeDiskBytes: hw.freeDiskBytes,
        gpu: advice.gpu,
      },
      reason: advice.reason,
      model: id
        ? {
            id,
            name: tier?.name ?? id,
            downloadBytes: tier?.downloadBytes ?? 0,
          }
        : null,
      ollama: { running, version: installation?.version ?? "" },
      downloaded: !!id && downloaded.includes(id),
      task: localRun ? { ...localRun.progress } : null,
      last: localLast,
      check: saved?.check ?? null,
      enabled: localUsable(saved),
      installUrl: localData.installUrl,
      minTokensPerSecond: localData.minTokensPerSecond,
      // What the smallest model needs, for the explanation on a computer that cannot run one.
      minimum: {
        ramGb: localData.minRamGb,
        vramGb: Math.min(...localData.tiers.map((t) => t.minVramGb)),
        unifiedGb: Math.min(...localData.tiers.map((t) => t.minUnifiedGb)),
        diskMarginGb: localData.diskMarginGb,
      },
    };
  }

  /** Turns the local model off and hands its tasks back to the other engines. */
  function dropLocal(saved: LocalSettings, check?: LocalCheck) {
    writeLocal(db, { ...saved, enabled: false, ...(check ? { check } : {}) });
    db.prepare(
      "DELETE FROM feature_engines WHERE json_extract(selection_json, '$.provider') = ?",
    ).run(LOCAL_PROVIDER);
    endConversations();
  }
  // Background recomputation is on in the app and off in unit tests, which
  // check the stored rows right after each call.
  let queue: Promise<unknown> = Promise.resolve();
  let lastAuto = 0;
  function reconfigure(rows?: OverviewRow[]): Promise<unknown> {
    const run = queue.then(() =>
      autoConfigureEngines(db, { rows })
        .then(() => options.onAuto?.())
        .catch(() => undefined),
    );
    queue = run;
    return run;
  }
  function reconfigureSoon(): void {
    if (options.auto) void reconfigure();
  }
  return {
    async overview() {
      const rows = await overviewRows();
      // Installs and sign-ins that happen outside Pyxis show up here, so a
      // changed engine set refreshes the automatic choices at most every 30 s.
      if (options.auto && Date.now() - lastAuto > 30_000) {
        lastAuto = Date.now();
        void reconfigure(rows);
      }
      return rows;
    },
    /**
     * Records that the student has read what these providers receive, then lets them take part in the automatic
     * choices. The recomputation lists models, which can take seconds, so the answer does not wait for it.
     */
    acknowledge(input: { providers: ProviderId[] }) {
      acknowledgeProviders(input.providers);
      lastAuto = Date.now();
      void reconfigure();
      return { ok: true as const };
    },
    async autoConfigure(input: { reset?: boolean; features?: string[] } = {}) {
      lastAuto = Date.now();
      const run = queue.then(() => autoConfigureEngines(db, input));
      queue = run.catch(() => undefined);
      // Screens that already read the old choices reload them.
      void run.then(() => options.onAuto?.()).catch(() => undefined);
      return run;
    },
    /**
     * What Pyxis knows about running a model on this computer: the hardware verdict, Ollama, the suggested model, a
     * download or check in progress, and the last check. The hardware query runs once per launch.
     */
    local: localState,
    /**
     * Downloads the suggested model through Ollama after the student agreed, then checks it. The local model turns on
     * when the check passes. Only offered when the hardware check suggests a model.
     */
    async localPull() {
      if (localRun) return localRun.promise;
      // A second press while this one still reads the state must not start a second download.
      if (localStarting) throw new IpcError("busy", "engines.local.busy");
      localStarting = true;
      const state = await localState().finally(() => {
        localStarting = false;
      });
      if (state.reason || !state.model)
        throw new IpcError("unsupported", "engines.local.cannotRun");
      if (!state.ollama.running)
        throw new IpcError("not-ready", "engines.local.ollamaMissing");
      // The student agreed to send study material to the model on this computer.
      acknowledgeProviders([LOCAL_PROVIDER]);
      const model = state.model.id;
      const abort = new AbortController();
      const run: LocalProgress = {
        phase: "pull",
        completed: 0,
        total: state.model.downloadBytes,
      };
      localLast = null;
      dropLocal({ model, enabled: false });
      const promise = (async () => {
        emitLocal({ phase: "pull", completed: 0, total: run.total });
        let shown = -1;
        await pullLocalModel(model, {
          signal: abort.signal,
          onProgress: (progress) => {
            run.completed = progress.completed;
            run.total = progress.total;
            // One update per whole percent is plenty for a progress bar.
            const percent = Math.floor(
              (progress.completed / Math.max(1, progress.total)) * 100,
            );
            if (percent === shown) return;
            shown = percent;
            emitLocal({ phase: "pull", ...progress });
          },
        });
        getFunnel().refresh(LOCAL_PROVIDER);
        run.phase = "check";
        emitLocal({ phase: "check" });
        const check = await checkLocalModel(model, { signal: abort.signal });
        writeLocal(db, { model, enabled: check.passed, check });
        emitLocal({ phase: "done" });
        reconfigureSoon();
        return check;
      })()
        .catch((err: unknown) => {
          const { cancelled, detail } = localStopped(err, abort);
          if (cancelled)
            throw new IpcError("aborted", "engines.local.cancelled");
          throw new IpcError("local-failed", "engines.local.pullFailed", {}, detail);
        })
        .finally(() => {
          if (localRun?.promise === promise) localRun = null;
        });
      localRun = { promise, abort, progress: run };
      return promise;
    },
    localCancel() {
      localRun?.abort.abort();
      return { ok: true as const };
    },
    /** Runs the check again on the downloaded model, for example after updating Ollama or closing other programs. */
    async localCheck() {
      const saved = readLocal(db);
      if (!saved) throw new IpcError("not-ready", "engines.local.cannotRun");
      if (localRun) throw new IpcError("busy", "engines.local.busy");
      const abort = new AbortController();
      const promise = checkLocalModel(saved.model, { signal: abort.signal });
      const run: LocalRun = {
        promise,
        abort,
        progress: { phase: "check", completed: 0, total: 0 },
      };
      localRun = run;
      localLast = null;
      emitLocal({ phase: "check" });
      try {
        const check = await promise;
        if (check.passed) writeLocal(db, { ...saved, enabled: true, check });
        else dropLocal(saved, check);
        emitLocal({ phase: "done" });
        reconfigureSoon();
        return check;
      } catch (err) {
        const { cancelled } = localStopped(err, abort);
        throw new IpcError(
          cancelled ? "aborted" : "local-failed",
          cancelled ? "engines.local.cancelled" : "engines.local.pullFailed",
        );
      } finally {
        if (localRun === run) localRun = null;
      }
    },
    /** Turns the local model on (only after a passed check) or off. Off hands its tasks back to the other engines. */
    localEnable(input: { enabled: boolean }) {
      const saved = readLocal(db);
      if (!saved) throw new IpcError("not-ready", "engines.local.cannotRun");
      if (input.enabled) {
        if (!localUsable({ ...saved, enabled: true }))
          throw new IpcError("unsupported", "engines.local.checkFirst");
        writeLocal(db, { ...saved, enabled: true });
      } else dropLocal(saved);
      reconfigureSoon();
      return { ok: true as const };
    },
    async models(input: { provider: ProviderId }) {
      await shellPathReady();
      const list = await getFunnel().models(input.provider);
      rememberModels(input.provider, list);
      return list.map((model) => ({
        id: model.id,
        name: model.name,
        efforts: model.efforts,
        defaultEffort: model.defaultEffort,
        fast: model.fast,
      }));
    },
    async test(
      input: {
        provider: ProviderId;
        model?: string;
        effort?: string;
        fast?: boolean;
      },
      signal?: AbortSignal,
    ) {
      if (disabled(input.provider)) {
        throw new IpcError("unsupported", "engines.disabled");
      }
      const started = Date.now();
      // The student's cancel and the deadline both stop the turn; only the deadline reads as a timeout.
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), TEST_DEADLINE_MS);
      try {
        const model = input.model || (await defaultModel(input.provider));
        // The screen can hold a level the chosen model does not list; the model gets the nearest one it has.
        const effort = resolveEffort(input.provider, model, input.effort);
        const result = await runTurn({
          selection: {
            provider: input.provider,
            model,
            effort,
            fast: input.fast,
          },
          prompt: "Reply with the word ok",
          signal: signal
            ? AbortSignal.any([signal, deadline.signal])
            : deadline.signal,
        });
        // The first successful confirmation becomes the default. INSERT OR
        // IGNORE preserves a choice made while this asynchronous test ran.
        db.prepare(
          "INSERT OR IGNORE INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, ?)",
        ).run(
          JSON.stringify({
            provider: input.provider,
            model: result.model,
            ...(effort ? { effort } : {}),
            ...(input.fast !== undefined ? { fast: input.fast } : {}),
            auto: true,
          }),
          Date.now(),
        );
        return {
          ok: true as const,
          latencyMs: Date.now() - started,
          model: result.model,
          inputTokens: result.inputTokens,
        };
      } catch (err) {
        if (signal?.aborted) throw err;
        if (deadline.signal.aborted)
          throw new IpcError("timeout", "engines.errors.timeout");
        const translated = translateEngineError(err, input.provider);
        throw new IpcError(
          translated.code,
          translated.messageKey,
          {},
          err instanceof Error ? err.message : "",
        );
      } finally {
        clearTimeout(timer);
      }
    },
    setFeature(input: {
      feature: (typeof features)[number];
      provider: ProviderId;
      model: string;
      effort?: string;
      fast?: boolean;
    }) {
      const local = input.provider === LOCAL_PROVIDER;
      if (!providers.has(input.provider) && !local) {
        throw invalidSelection();
      }
      if (local) {
        // Only the checked model, and only while it is on.
        const saved = readLocal(db);
        if (!localUsable(saved) || saved!.model !== input.model)
          throw new IpcError("unsupported", "engines.local.checkFirst");
        if (
          localData.strictFeatures.includes(input.feature) &&
          !saved!.check!.structured
        )
          throw new IpcError("unsupported", "engines.local.noStructured");
      }
      if (disabled(input.provider))
        throw new IpcError("unsupported", "engines.disabled");
      if (!isProviderAcknowledged(input.provider))
        throw new IpcError(
          "disclosure-required",
          "engines.errors.disclosure-required",
        );
      const capability = getFunnel().providers[input.provider]!.capabilities;
      if (
        (input.effort && !capability.effort) ||
        (input.fast && !capability.fast)
      )
        throw invalidSelection();
      const warning =
        input.feature === "vision"
          ? capabilityWarning(input.model, "vision")
          : null;
      const now = Date.now();
      db.prepare(
        `INSERT INTO feature_engines (feature, selection_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(feature) DO UPDATE SET selection_json = excluded.selection_json, updated_at = excluded.updated_at`,
      ).run(
        input.feature,
        JSON.stringify({
          provider: input.provider,
          model: input.model,
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.fast !== undefined ? { fast: input.fast } : {}),
        }),
        now,
      );
      // A chat that talked to the old engine starts over with the new one.
      endConversations();
      return { warning };
    },
    /** Sets, or with no `effort` clears, the student's reasoning effort for one task. */
    setEffort(input: { feature: (typeof features)[number]; effort?: string }) {
      const row = db
        .prepare(`SELECT selection_json FROM feature_engines WHERE feature = ?`)
        .get(input.feature) as { selection_json: string } | undefined;
      if (!row)
        throw invalidSelection();
      const {
        effort: _old,
        effortChoice: _choice,
        ...rest
      } = JSON.parse(row.selection_json) as StoredSelection;
      const listed = effortsOf(rest.provider, rest.model);
      if (input.effort && listed && !listed.includes(input.effort))
        throw invalidSelection();
      // Pyxis's own rows keep the pick beside the effort it works out; a pinned row stores the pick as its effort.
      const effort =
        input.effort ??
        (rest.auto && listed
          ? automaticEffort(input.feature, listed)
          : undefined);
      db.prepare(
        `UPDATE feature_engines SET selection_json = ?, updated_at = ? WHERE feature = ?`,
      ).run(
        JSON.stringify({
          ...rest,
          ...(effort ? { effort } : {}),
          ...(rest.auto && input.effort ? { effortChoice: input.effort } : {}),
        }),
        Date.now(),
        input.feature,
      );
      endConversations();
      return { ok: true as const };
    },
    capability(input: { model: string; need: Need }) {
      return { warning: capabilityWarning(input.model, input.need) };
    },
    usage(input: { since: number }) {
      return usageSince(db, input.since).map((row) => ({
        ...row,
        name: providerName(row.provider),
      }));
    },
    features() {
      return readFeatures(db);
    },
    remove(input: { provider: ProviderId }) {
      if (!providers.has(input.provider))
        throw invalidSelection();
      db.prepare(
        "DELETE FROM feature_engines WHERE json_extract(selection_json, '$.provider') = ?",
      ).run(input.provider);
      endConversations();
      reconfigureSoon();
      return { ok: true as const };
    },
    async logout(input: { provider: ProviderId }) {
      requireCli(input.provider);
      if (NO_SIGN_OUT.has(input.provider))
        throw new IpcError("unsupported", "engines.signOutUnsupported");
      loginSessions.get(input.provider)?.cancel();
      loginSessions.delete(input.provider);
      endConversations();
      await shellPathReady();
      await getFunnel().logout(input.provider);
      hadEngines.delete(db);
      if (options.auto) await reconfigure();
      return { ok: true as const };
    },
    async update(input: { provider: ProviderId }) {
      requireCli(input.provider);
      await shellPathReady();
      const result = await getFunnel().update(input.provider);
      if (result.changed && options.auto) await reconfigure();
      return {
        changed: result.changed,
        version: result.to ?? result.from ?? "",
      };
    },
    async login(input: { provider: ProviderId }) {
      requireCli(input.provider);
      loginSessions.get(input.provider)?.cancel();
      const session = getFunnel().login(input.provider);
      loginSessions.set(input.provider, session);
      const iterator = session[Symbol.asyncIterator]();
      try {
        let step = await iterator.next();
        while (!step.done && step.value.type === "log")
          step = await iterator.next();
        // A session that ended before its first event, after cancelLogin or a newer login replaced it, was cancelled.
        const cancelled = loginSessions.get(input.provider) !== session;
        void (async () => {
          try {
            let next = await iterator.next();
            while (!next.done) {
              if (next.value.type !== "log")
                emit(notice(input.provider, next.value));
              // Signed in is shown at once; choosing models can take seconds and happens after.
              if (next.value.type === "done") reconfigureSoon();
              next = await iterator.next();
            }
          } catch {
            emit({ provider: input.provider, type: "error" });
          } finally {
            if (loginSessions.get(input.provider) === session)
              loginSessions.delete(input.provider);
          }
        })();
        if (step.value?.type === "done") reconfigureSoon();
        if (step.value) return notice(input.provider, step.value);
        return cancelled
          ? { provider: input.provider, type: "cancelled" }
          : { provider: input.provider, type: "error", message: "no-event" };
      } catch {
        // A sign-in the student cancelled, or a newer one replaced, is not a failure.
        if (loginSessions.get(input.provider) !== session)
          return { provider: input.provider, type: "cancelled" };
        loginSessions.delete(input.provider);
        throw new IpcError("cli-failed", "engines.errors.cli-failed");
      }
    },
    /**
     * Runs the vendor's official installer for a CLI that is not on this computer yet. A second call while one runs
     * waits for the same install.
     */
    install(input: { provider: ProviderId }) {
      if (!isInstallable(input.provider) || disabled(input.provider))
        throw new IpcError("unsupported", "engines.disabled");
      const running = installs.get(input.provider);
      if (running) return running.promise;
      const abort = new AbortController();
      const promise = runInstaller(input.provider, {
        signal: abort.signal,
        command: options.installerFixture
          ? ["/bin/sh", [options.installerFixture, input.provider]]
          : undefined,
        onLog: (text) =>
          options.onInstallLog?.({ provider: input.provider, text }),
      })
        .then(
          () => {
            reconfigureSoon();
            return { ok: true as const };
          },
          (err: unknown) => {
            if (abort.signal.aborted)
              throw new IpcError("aborted", "setup.install.cancelled");
            throw new IpcError(
              "install-failed",
              "setup.install.failed",
              {},
              err instanceof Error ? err.message : String(err),
            );
          },
        )
        .finally(() => installs.delete(input.provider));
      installs.set(input.provider, { promise, abort });
      return promise;
    },
    cancelInstall(input: { provider: ProviderId }) {
      installs.get(input.provider)?.abort.abort();
      return { ok: true as const };
    },
    /** Stops a sign-in the student walked away from, so its events cannot reach another engine's screen. */
    cancelLogin(input: { provider: ProviderId }) {
      loginSessions.get(input.provider)?.cancel();
      loginSessions.delete(input.provider);
      return { ok: true as const };
    },
    sendCode(input: { provider: ProviderId; code: string }) {
      const session = loginSessions.get(input.provider);
      if (!session)
        throw new IpcError("not-ready", "engines.errors.not-logged-in");
      session.sendCode(input.code);
      return {};
    },
  };
}

async function defaultModel(provider: ProviderId): Promise<string> {
  const models = await getFunnel().models(provider);
  return models[0]?.id ?? "";
}
