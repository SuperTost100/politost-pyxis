import type Database from "better-sqlite3";
import { IpcError } from "../../shared/ipc";
import { capabilityWarning } from "./capabilities";
import { translateEngineError } from "./errors";
import { getFunnel, runTurn, type ProviderId } from "./funnel";

const features = ["default", "chat", "plan", "lesson", "grading", "map", "vision"] as const;
const disabled = new Set<ProviderId>(["agent", "antigravity"]);

const loginSessions = new Map<string, { sendCode: (code: string) => void; cancel: () => void }>();

function kindOf(id: string): "cli" | "api" {
  return id.endsWith("-api") ? "api" : "cli";
}

export function engineHandlers(db: Database.Database) {
  return {
    async overview() {
      const rows = await getFunnel().overview();
      return rows.map((row) => ({
        id: row.id,
        name: row.displayName,
        kind: kindOf(row.id),
        installed: row.installation.installed,
        loggedIn: row.auth?.loggedIn ?? false,
        disabled: disabled.has(row.id),
        version: row.installation.version ?? "",
      }));
    },
    async models(input: { provider: ProviderId }) {
      const list = await getFunnel().models(input.provider);
      return list.map((model) => ({ id: model.id, name: model.name }));
    },
    async test(input: { provider: ProviderId; model?: string }) {
      if (disabled.has(input.provider)) {
        throw new IpcError("unsupported", "engines.disabled");
      }
      const started = Date.now();
      try {
        const result = await runTurn({
          selection: {
            provider: input.provider,
            model: input.model || (await defaultModel(input.provider)),
          },
          prompt: "Reply with the word ok",
        });
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
    setFeature(input: { feature: (typeof features)[number]; provider: ProviderId; model: string }) {
      const warning =
        input.feature === "vision" ? capabilityWarning(input.model, "vision") : null;
      const now = Date.now();
      db.prepare(
        `INSERT INTO feature_engines (feature, selection_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(feature) DO UPDATE SET selection_json = excluded.selection_json, updated_at = excluded.updated_at`,
      ).run(input.feature, JSON.stringify({ provider: input.provider, model: input.model }), now);
      return { warning };
    },
    features() {
      const rows = db
        .prepare(`SELECT feature, selection_json FROM feature_engines`)
        .all() as Array<{ feature: string; selection_json: string }>;
      return Object.fromEntries(rows.map((row) => [row.feature, JSON.parse(row.selection_json)]));
    },
    async login(input: { provider: ProviderId }) {
      if (disabled.has(input.provider)) throw new IpcError("unsupported", "engines.disabled");
      const session = getFunnel().login(input.provider);
      loginSessions.set(input.provider, session);
      const iterator = session[Symbol.asyncIterator]();
      let step = await iterator.next();
      while (!step.done && step.value.type === "log") step = await iterator.next();
      // ponytail: the rest of the login stream is drained so the CLI can finish. A later code prompt that arrives after the first event is missed until login is started again.
      void (async () => {
        let next = step;
        while (!next.done) next = await iterator.next();
      })();
      return step.value ?? { type: "error" as const, message: "no-event" };
    },
    sendCode(input: { provider: ProviderId; code: string }) {
      const session = loginSessions.get(input.provider);
      if (!session) throw new IpcError("not-ready", "engines.errors.not-logged-in");
      session.sendCode(input.code);
      return {};
    },
  };
}

async function defaultModel(provider: ProviderId): Promise<string> {
  const models = await getFunnel().models(provider);
  return models[0]?.id ?? "";
}

