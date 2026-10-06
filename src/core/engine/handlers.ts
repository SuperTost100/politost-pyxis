import type Database from "better-sqlite3";
import { engineProviders, IpcError } from "../../shared/ipc";
import { capabilityWarning, type Need } from "./capabilities";
import { translateEngineError } from "./errors";
import { getFunnel, runTurn, type ProviderId } from "./funnel";

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
  message?: string;
  command?: string[];
};

function notice(
  provider: string,
  event: { type: string; url?: string; message?: string; command?: string[] },
): LoginNotice {
  return {
    provider,
    type: event.type,
    url: "url" in event ? event.url : undefined,
    message: "message" in event ? event.message : undefined,
    command: "command" in event ? event.command : undefined,
  };
}

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

function disabled(id: string): boolean {
  const provider = getFunnel().providers[id as ProviderId];
  return !provider || !textOnly(id, provider.capabilities.access);
}

export function engineHandlers(
  db: Database.Database,
  emit: (event: LoginNotice) => void,
) {
  return {
    async overview() {
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
            capabilities: {
              effort: row.capabilities.effort,
              fast: row.capabilities.fast,
            },
          };
        }),
      );
    },
    async models(input: { provider: ProviderId }) {
      const list = await getFunnel().models(input.provider);
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
        const result = await runTurn({
          selection: {
            provider: input.provider,
            model: input.model || (await defaultModel(input.provider)),
            effort: input.effort,
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
            ...(input.effort ? { effort: input.effort } : {}),
            ...(input.fast !== undefined ? { fast: input.fast } : {}),
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
        const translated = translateEngineError(err);
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
      return { warning };
    },
    clearFeature(input: {
      feature: Exclude<(typeof features)[number], "default">;
    }) {
      db.prepare(`DELETE FROM feature_engines WHERE feature = ?`).run(
        input.feature,
      );
      return { ok: true as const };
    },
    capability(input: { model: string; need: Need }) {
      return { warning: capabilityWarning(input.model, input.need) };
    },
    features() {
      const rows = db
        .prepare(`SELECT feature, selection_json FROM feature_engines`)
        .all() as Array<{ feature: string; selection_json: string }>;
      return Object.fromEntries(
        rows.map((row) => [row.feature, JSON.parse(row.selection_json)]),
      );
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
      return { ok: true as const };
    },
    async logout(input: { provider: ProviderId }) {
      if (
        !providers.has(input.provider) ||
        disabled(input.provider) ||
        input.provider.endsWith("-api")
      )
        throw new IpcError("unsupported", "engines.disabled");
      loginSessions.get(input.provider)?.cancel();
      loginSessions.delete(input.provider);
      await getFunnel().logout(input.provider);
      return { ok: true as const };
    },
    async update(input: { provider: ProviderId }) {
      if (
        !providers.has(input.provider) ||
        disabled(input.provider) ||
        input.provider.endsWith("-api")
      )
        throw new IpcError("unsupported", "engines.disabled");
      const result = await getFunnel().update(input.provider);
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
        void (async () => {
          try {
            let next = await iterator.next();
            while (!next.done) {
              if (next.value.type !== "log")
                emit(notice(input.provider, next.value));
              next = await iterator.next();
            }
          } catch {
            emit({ provider: input.provider, type: "error" });
          } finally {
            if (loginSessions.get(input.provider) === session)
              loginSessions.delete(input.provider);
          }
        })();
        return step.value ?? { type: "error" as const, message: "no-event" };
      } catch {
        if (loginSessions.get(input.provider) === session)
          loginSessions.delete(input.provider);
        throw new IpcError("cli-failed", "engines.errors.cli-failed");
      }
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
