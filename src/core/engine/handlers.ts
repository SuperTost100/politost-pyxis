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
import { rememberReady, type StoredSelection } from "./selection";
import { usageSince } from "./usage";

const features = [
  "default",
  "chat",
  "plan",
  "lesson",
  "grading",
  "map",
  "vision",
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

/** A CLI runs only when its adapter enforces text-only access. API providers have no machine access. */
function textOnly(id: string, access: readonly string[] = []): boolean {
  return kindOf(id) === "api" || access.includes("none");
}

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
  // A failed model listing is not proof that the engine went away. Keep the
  // current choices rather than blanking them.
  const unreadable = failed > 0 && listed.length === 0;
  // A task whose engine hits a usage limit switches to the next one from this list.
  if (!unreadable) rememberReady(listed);
  const plan = planAuto(listed);
  const now = Date.now();
  const apply = db.transaction(() => {
    // A reset that cannot read any model list would leave every feature without an engine.
    if (unreadable) return;
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
    ready: ready.map((row) => row.id),
    features: readFeatures(db),
  };
}

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
  } = {},
) {
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
    async test(input: {
      provider: ProviderId;
      model?: string;
      effort?: string;
      fast?: boolean;
    }) {
      if (disabled(input.provider)) {
        throw new IpcError("unsupported", "engines.disabled");
      }
      const started = Date.now();
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
        const translated = translateEngineError(err, input.provider);
        throw new IpcError(
          translated.code,
          translated.messageKey,
          {},
          err instanceof Error ? err.message : "",
        );
      }
    },
    setFeature(input: {
      feature: (typeof features)[number];
      provider: ProviderId;
      model: string;
      effort?: string;
      fast?: boolean;
    }) {
      if (!providers.has(input.provider)) {
        throw new IpcError(
          "invalid-selection",
          "engines.errors.invalid-selection",
        );
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
        throw new IpcError(
          "invalid-selection",
          "engines.errors.invalid-selection",
        );
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
        throw new IpcError(
          "invalid-selection",
          "engines.errors.invalid-selection",
        );
      const {
        effort: _old,
        effortChoice: _choice,
        ...rest
      } = JSON.parse(row.selection_json) as StoredSelection;
      const listed = effortsOf(rest.provider, rest.model);
      if (input.effort && listed && !listed.includes(input.effort))
        throw new IpcError(
          "invalid-selection",
          "engines.errors.invalid-selection",
        );
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
    clearFeature(input: {
      feature: Exclude<(typeof features)[number], "default">;
    }) {
      db.prepare(`DELETE FROM feature_engines WHERE feature = ?`).run(
        input.feature,
      );
      endConversations();
      reconfigureSoon();
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
        throw new IpcError(
          "invalid-selection",
          "engines.errors.invalid-selection",
        );
      db.prepare(
        "DELETE FROM feature_engines WHERE json_extract(selection_json, '$.provider') = ?",
      ).run(input.provider);
      endConversations();
      reconfigureSoon();
      return { ok: true as const };
    },
    async logout(input: { provider: ProviderId }) {
      if (
        !providers.has(input.provider) ||
        disabled(input.provider) ||
        input.provider.endsWith("-api")
      )
        throw new IpcError("unsupported", "engines.disabled");
      if (NO_SIGN_OUT.has(input.provider))
        throw new IpcError("unsupported", "engines.signOutUnsupported");
      loginSessions.get(input.provider)?.cancel();
      loginSessions.delete(input.provider);
      endConversations();
      await shellPathReady();
      await getFunnel().logout(input.provider);
      if (options.auto) await reconfigure();
      return { ok: true as const };
    },
    async update(input: { provider: ProviderId }) {
      if (
        !providers.has(input.provider) ||
        disabled(input.provider) ||
        input.provider.endsWith("-api")
      )
        throw new IpcError("unsupported", "engines.disabled");
      await shellPathReady();
      const result = await getFunnel().update(input.provider);
      if (result.changed && options.auto) await reconfigure();
      return {
        changed: result.changed,
        version: result.to ?? result.from ?? "",
      };
    },
    async login(input: { provider: ProviderId }) {
      if (
        !providers.has(input.provider) ||
        disabled(input.provider) ||
        input.provider.endsWith("-api")
      )
        throw new IpcError("unsupported", "engines.disabled");
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
