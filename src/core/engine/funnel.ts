import type Database from "better-sqlite3";
import { tierData } from "./tiers";
import { createDisclosure } from "./disclosure";
import {
  createApiProviders,
  createFunnel,
  FunnelError,
  type Funnel,
  type HistoryStore,
  type Provider,
  type ProviderId,
  type Selection,
  redact,
} from "cli-funnel";

export type { ProviderId, Selection };
export { FunnelError };
import { clearSignOut } from "./bench";
import { shellPathReady } from "./shell-path";
import { setRedact, startCall } from "../debug/log";
import { trackCall } from "../jobs/activity";
import { currentUsageScope, reportUsage } from "./usage";
import { retiredProviders } from "../../shared/limits";
import { TOOL_NAMES } from "../../shared/tool-names";

// Debug mode's log masks every line with cli-funnel's redact before it writes it.
setRedact(redact);
export { redact };
export { loadShellPath, shellPathReady } from "./shell-path";

export type EngineResult = {
  text: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens?: number;
  /** Input tokens read from the provider's prompt cache, billed at its cache rate. */
  cacheReadTokens?: number;
  /** Input tokens written to the prompt cache (Anthropic). */
  cacheWriteTokens?: number;
  structured?: unknown;
  structuredError?: string;
  /** Why the engine stopped writing: "length" (out of room) and "error" (the stream ended without its final event) mean the text is cut short. */
  finishReason?: string;
  /** For a chat turn on a CLI tool: the tool's session id, which the next turn resumes by (`TurnInput.conversation.session`). */
  sessionId?: string;
  /** The folder the tool keyed that session by. */
  cwd?: string;
  /** The turn went on in the stored session. False when it started a new one (another tool, a folder that changed, a session the tool no longer knew). */
  continued?: boolean;
  /** Pyxis's tools went with the run that answered (`TurnInput.tools`). */
  tools?: boolean;
};

type Keys = { anthropic?: string; openai?: string };
const apiIds = ["anthropic-api", "openai-api"] as const;
type ApiId = (typeof apiIds)[number];
const vendorOf = (id: ApiId) =>
  id === "anthropic-api" ? "anthropic" : "openai";

/** A chat's live CLI process closes after this long without a question. The chat's session stays stored and resumes by id. */
export const CONVERSATION_IDLE_MS = 10 * 60_000;
/** Characters an API or local conversation may carry. Past this the next question starts a new one with the recent turns only. */
const CONVERSATION_CHARS = 150_000;

let keys: Keys = {};
/** Conversations of the API providers. Pyxis keeps its own store so a key change can drop the previous account's. */
const histories = new Map<string, unknown[]>();
const MAX_HISTORIES = 200;
const history: HistoryStore = {
  get: (id) => histories.get(id),
  set: (id, messages) => {
    histories.delete(id);
    histories.set(id, messages);
    if (histories.size > MAX_HISTORIES)
      histories.delete(histories.keys().next().value!);
  },
};
let api: Record<string, Provider> | undefined;
let funnel: Funnel | null = null;
let scratch = "";
let disclosure: ReturnType<typeof createDisclosure> | undefined;
export function configureDisclosure(db: Database.Database) {
  disclosure = createDisclosure(db);
}
export function acknowledgeProviders(providers: readonly string[]) {
  disclosure?.acknowledge(providers);
}
/** True when the student has seen what this provider receives. Without a configured store nothing is gated. */
export function isProviderAcknowledged(provider: string): boolean {
  return disclosure?.isAcknowledged(provider) ?? true;
}

export function setScratch(path: string): void {
  scratch = path;
}

/**
 * The API providers sit behind stable stand-ins, so new keys replace only them: the funnel keeps the CLI detection and
 * model lists it already cached, and refreshes the API provider whose key changed.
 */
function apiProvider(id: ApiId): Provider {
  const target = () => (api ??= createApiProviders(keys))[id]!;
  return {
    id,
    get displayName() {
      return target().displayName;
    },
    get capabilities() {
      return target().capabilities;
    },
    detect: () => target().detect(),
    authStatus: () => target().authStatus(),
    login: (options) => target().login(options),
    logout: () => target().logout(),
    update: () => target().update(),
    models: (context) => target().models(context),
    run: (input) => target().run(input),
  };
}

export function setApiKeys(next: Keys): void {
  const changed = apiIds.filter(
    (id) => keys[vendorOf(id)] !== next[vendorOf(id)],
  );
  keys = { anthropic: next.anthropic, openai: next.openai };
  if (changed.length === 0) return;
  api = undefined;
  // A conversation held for the previous key must not continue under the new one.
  for (const [key, talk] of conversations)
    if (talk.provider.endsWith("-api")) endConversation(key);
  histories.clear();
  for (const id of changed) {
    funnel?.refresh(id);
    // A new key may work where the old one was refused.
    clearSignOut(id);
  }
}

export function getFunnel(): Funnel {
  if (!funnel) {
    funnel = createFunnel({
      providers: Object.fromEntries(apiIds.map((id) => [id, apiProvider(id)])),
      // Claude Code and Codex keep a chat's process between questions. Other runs close theirs when they end.
      sessions: { keepAlive: true, idleMs: CONVERSATION_IDLE_MS },
      history,
      // A local model stays loaded as long as a chat's conversation lasts, so a follow-up question does not reload it.
      ollama: { keepAlive: `${CONVERSATION_IDLE_MS / 60_000}m` },
    });
    // A tool Pyxis no longer offers is left out of this funnel's registry, so `overview()` never runs its program to
    // detect or ask for its sign-in (two calls with 15 second deadlines on a machine that still has it installed).
    for (const id of retiredProviders) delete (funnel.providers as Partial<Record<string, unknown>>)[id];
  }
  return funnel;
}

/** The provider's name as a student knows it ("Claude" for the program Claude Code), for notices. */
export function providerName(id: string): string {
  return TOOL_NAMES[id] ?? getFunnel().providers[id as ProviderId]?.displayName ?? id;
}

type Conversation = {
  provider: ProviderId;
  /** For an API or local conversation: engine and system prompt it started with. A change starts a new one. */
  fingerprint: string;
  sessionId?: string;
  chars: number;
  lastUsed: number;
  busy: boolean;
  /** The chat was left while a turn ran; the live process ends when the turn does. */
  leaving: boolean;
};

const conversations = new Map<string, Conversation>();

/**
 * A chat, a lesson or a quiz hand-in on a subscription CLI (Claude Code, Codex, Antigravity) keeps its
 * session in the database and continues it by id, in a live process or in a new one. API providers and Ollama keep their conversation as history
 * in this process.
 */
function isToolProvider(provider: ProviderId): boolean {
  return !provider.endsWith("-api") && provider !== "ollama";
}

/**
 * True for the subscription tools, whose resumed session goes on answering by the first system prompt it was opened under,
 * whatever `system` a later call gives (checked on Claude Code, Codex and Antigravity with a rule in each prompt). A change
 * of the chat's instructions reaches such a session only in the message. API providers and Ollama keep no session: their
 * conversation is dropped when the system prompt changes (`conversationFor`). It is separate from what a continuing call
 * sends in the `system` field, which is always the current one.
 */
export function keepsFirstSystemPrompt(provider: string): boolean {
  return isToolProvider(provider as ProviderId);
}

/** The folder name that keeps Pyxis's chats apart from every other app's in Antigravity's history. */
const WORKSPACE_NAME = "pyxis";

/**
 * The CLIs word the failure of a resume differently: Claude Code "No conversation found with session ID", Codex "no
 * rollout found for thread id", Antigravity "Conversation ... was not found".
 */
const SESSION_GONE = /no conversation found|no rollout found|conversation .{0,80}was not found|session .{0,80}not found/i;

export function isSessionGone(err: unknown): boolean {
  return SESSION_GONE.test(err instanceof Error ? err.message : String(err));
}

/**
 * Antigravity over ACP ends a turn it refused for its quota as a finished one, with its notice as the whole answer, and
 * cli-funnel 1.0.0 passes it on as text. Read as an answer, a structured call repairs it twice and stops as a reply that
 * cannot be used, and a chat, a lesson or a quiz streams it as the start of a reply. The wording is agy 1.5.17's, recorded
 * on 2026-11-25: "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in
 * 3h30m10s." The message must be exactly that, give or take the space around it, and one of two signals must say agy
 * wrote it rather than a model quoting it: the turn reports no output tokens (19 of the 20 notices recorded that day came
 * with no usage at all), or a tool call came before it in the turn and it came as agy frames it, one chunk that starts and
 * ends with a line break (the 20th: the quota ran out after the model had reasoned and tried a tool, 930 output tokens).
 * Any other message that reports output tokens is an answer. The message is the text after the turn's last tool call,
 * since the quota can run out after the model already wrote and called a tool. Known limit: a real reply that begins
 * with the notice's words and is stopped before more arrives loses that held start.
 * shortcut: matches agy 1.5.17's English wording; remove once cli-funnel reports the notice as a limit.
 */
const AGY_QUOTA_HEAD =
  "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in ";
const AGY_QUOTA_RESET = /^(?=\d)(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\.$/;

/** True while the reply so far may still turn out to be the whole quota notice, so a stream holds it back. */
function mayBeAgyQuota(text: string): boolean {
  const reply = text.trimStart();
  if (AGY_QUOTA_HEAD.startsWith(reply)) return true;
  return reply.startsWith(AGY_QUOTA_HEAD) && /^[\dhms]*\.?\s*$/.test(reply.slice(AGY_QUOTA_HEAD.length));
}

/** The usage-limit error, shaped as cli-funnel shapes one, for Antigravity's quota notice; undefined for any other reply. */
function antigravityQuota(
  provider: string,
  text: string,
  usage: { outputTokens?: number } | undefined,
  /** A tool call came before the message, and the message came in one chunk. */
  afterCall: boolean,
  now = Date.now(),
): Error | undefined {
  if (provider !== "antigravity") return undefined;
  if ((usage?.outputTokens ?? 0) > 0 && !(afterCall && /^\n[^\n]+\n$/.test(text))) return undefined;
  const detail = text.trim();
  const reset = detail.startsWith(AGY_QUOTA_HEAD) ? AGY_QUOTA_RESET.exec(detail.slice(AGY_QUOTA_HEAD.length)) : null;
  if (!reset) return undefined;
  const [, hours = "0", minutes = "0", seconds = "0"] = reset;
  const wait = ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
  return Object.assign(new Error(detail), {
    code: "cli-failed",
    limit: { kind: "quota", detail, retryAfterMs: wait, resetAt: new Date(now + wait).toISOString() },
  });
}

/**
 * True for the failure of a turn in which a call reached Pyxis's tools. The call may have saved something (cards), so the
 * turn is not replayed on another tool, which would not know and make it again.
 */
export function reachedTools(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "toolsReached" in err && err.toolsReached);
}

/** Thrown inside a turn when the tool started another session than the one it was asked to resume. */
class SessionReplaced extends Error {}

/** Ends a chat's live process. The stored session stays, and the next turn resumes it. A turn still running finishes first. */
export function endConversation(key: string): void {
  const talk = conversations.get(key);
  if (!talk) return;
  if (talk.busy) {
    talk.leaving = true;
    return;
  }
  conversations.delete(key);
  if (talk.sessionId && funnel?.sessionsEnabled)
    funnel.closeSession(talk.sessionId, talk.provider);
}

/** Ends every chat's live process, for example after the student changed engines. */
export function endConversations(): void {
  for (const key of [...conversations.keys()]) endConversation(key);
}

/** Stops every live CLI process, when the app quits. */
export function closeFunnel(): void {
  conversations.clear();
  funnel?.close();
}

/** The live process the chat's CLI turns run on. A turn on another tool stops the previous tool's process. */
function toolTalk(key: string, provider: ProviderId): Conversation {
  const talk = conversations.get(key);
  if (talk && talk.provider === provider && !talk.busy) return talk;
  if (talk && !talk.busy) endConversation(key);
  // A turn beside one still running goes outside the tracked process; the running turn's own entry stays.
  const fresh: Conversation = {
    provider,
    fingerprint: "",
    chars: 0,
    lastUsed: Date.now(),
    busy: false,
    leaving: false,
  };
  if (!conversations.has(key)) conversations.set(key, fresh);
  return fresh;
}

/** The API or local chat's conversation when it can go on with this engine and system prompt, else a new one. */
function conversationFor(
  key: string,
  selection: Selection,
  system: string | undefined,
): Conversation | undefined {
  if (!keepsConversation(selection.provider)) {
    endConversation(key);
    return undefined;
  }
  const fingerprint = JSON.stringify([
    selection.provider,
    selection.model,
    selection.effort ?? null,
    selection.fast ?? null,
    system ?? null,
  ]);
  const talk = conversations.get(key);
  if (talk?.busy) {
    // This turn runs beside the session, which then misses its exchange: the conversation ends after the running turn.
    talk.leaving = true;
    return undefined;
  }
  if (
    talk &&
    talk.fingerprint === fingerprint &&
    Date.now() - talk.lastUsed < CONVERSATION_IDLE_MS &&
    talk.chars < CONVERSATION_CHARS
  )
    return talk;
  endConversation(key);
  const fresh: Conversation = {
    provider: selection.provider,
    fingerprint,
    chars: 0,
    lastUsed: Date.now(),
    busy: false,
    leaving: false,
  };
  conversations.set(key, fresh);
  return fresh;
}

/** API providers and Ollama keep a conversation as history in this process. */
function keepsConversation(provider: ProviderId): boolean {
  return provider.endsWith("-api") || provider === "ollama";
}

export type TurnInput = {
  selection: Omit<Selection, "cwd" | "access"> & { cwd?: string };
  prompt: string;
  system?: string;
  responseSchema?: { name?: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  attachments?: Array<{
    type: "image";
    mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    data: string;
  }>;
  /**
   * A chat that keeps its conversation with the engine. `prompt` is the whole context and starts a conversation;
   * `followUp` (the new message) continues one the engine still holds.
   *
   * On a subscription CLI the conversation is the tool's own session, which the chat stored: `session` names it, and
   * the turn continues it by id, in a live process or a new one, when it runs on the same tool in the same folder. A
   * session the tool no longer knows (Claude Code, Codex and Antigravity say so) starts over with `prompt`. The result
   * carries the session id to store. `onSession` hears it as soon as the tool reports it, so a turn the student stops
   * leaves a session the next turn can continue.
   */
  conversation?: {
    key: string;
    followUp: string;
    /**
     * The session the chat stored: an object to continue it, null for a chat that stores sessions and has none to continue.
     * Left out, the caller stores nothing (a lesson's tool rounds), and a tool's session is continued from the id this
     * process tracked for the key.
     */
    session?: { provider: string; id: string; cwd: string } | null;
    /** `tools`: the run that reported the session has Pyxis's tools attached. */
    onSession?: (sessionId: string, provider: string, cwd: string, tools?: boolean) => void;
    /**
     * Only a subscription CLI keeps this conversation. An API or local provider answers each call on its own, with the
     * whole prompt, because their history lives in this process, which a local model's small window cannot hold. A
     * lesson and a quiz hand-in set it.
     */
    cliOnly?: boolean;
  };
  /** Mark the system prompt and the conversation so far for the provider's prompt cache, where it has one. */
  cache?: boolean;
  /**
   * Pyxis's tools for this turn (`src/core/tools/server.ts`): the server's address and the chat's bearer token. They are
   * attached only where `toolsAttach` says the answering tool takes them, and the turn otherwise runs as before, with no
   * tools. `onTool` hears each call to them as the tool reports it starting and ending, which the chat shows in place.
   */
  tools?: {
    url: string;
    token: string;
    onTool?: (event: { phase: "start" | "end"; id: string; tool: string; failed?: boolean }) => void;
  };
};

/**
 * The name Pyxis's server goes by in a run; the tools reach the model as `mcp__pyxis_tools__…` and the like. Codex refuses
 * a run whose server name its own config already has, so the name is one a user's config is unlikely to hold. No stored
 * session depends on it: a resumed session is handed the server again, under this name, on every turn.
 */
export const TOOL_SERVER = "pyxis_tools";

/**
 * The tools that refused Pyxis's server since core started (a `pyxis_tools` server already in the user's Codex config, a
 * transport without servers). They are not offered it again until the next start, so each question resumes its session
 * on one run instead of a refused attempt and a new session without tools.
 */
const refusedTools = new Set<string>();

/** This tool refused Pyxis's server: it is not offered it again until core restarts. */
export function markToolsRefused(provider: string): void {
  refusedTools.add(provider);
}

/**
 * Whether a run on this provider takes Pyxis's tools: the provider must accept an HTTP MCP server at access `none`
 * (`capabilities.mcpServersAtNone`), where the server's tools are the only ones the model can call. Claude Code, Codex
 * and Antigravity over ACP do; Cursor Agent, the API providers and Ollama do not. Antigravity refuses them on Windows
 * until a live run there shows its hook denying the other tools, and cli-funnel's capability does not vary by platform,
 * so the platform is checked here.
 */
export function toolsAttach(provider: string, platform: NodeJS.Platform = process.platform): boolean {
  if (refusedTools.has(provider)) return false;
  const capabilities = getFunnel().providers[provider as ProviderId]?.capabilities;
  if (!capabilities?.mcpServersAtNone?.includes("http")) return false;
  return !(provider === "antigravity" && platform === "win32");
}

/**
 * A run that failed because of the tools it was given, before it answered: a server name the user's Codex config already
 * has (`invalid-selection`), a transport that refuses servers (`unsupported`), or a CLI that could not start the server.
 * The turn then runs again without tools, as it would on a tool that takes none, but only when the attempt wrote nothing
 * and called none of Pyxis's tools: a call may already have saved cards, which a second attempt would make again.
 */
function toolsRefused(err: unknown): boolean {
  const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
  const message = err instanceof Error ? err.message : String(err);
  return code === "invalid-selection" || code === "unsupported" || /\bmcp\b/i.test(message);
}

export async function runTurn(input: TurnInput): Promise<EngineResult> {
  disclosure?.ensure(input.selection.provider, input.signal);
  try {
    return await turn(input);
  } catch (err) {
    // Antigravity reports a cancelled run as a failed one. Callers expect an abort.
    if (input.signal?.aborted)
      throw new DOMException("Engine turn cancelled", "AbortError");
    throw err;
  }
}

/** Ollama's own default context is a few thousand tokens and it drops the start of a longer prompt without a word. */
function localContextWindow(model: string): number | undefined {
  return tierData.local.tiers.find((tier) => tier.model === model)?.contextWindow;
}

async function turn(input: TurnInput): Promise<EngineResult> {
  await shellPathReady();
  const contextWindow =
    input.selection.provider === "ollama"
      ? (input.selection.contextWindow ??
        localContextWindow(input.selection.model))
      : input.selection.contextWindow;
  const selection = {
    ...input.selection,
    ...(contextWindow ? { contextWindow } : {}),
    cwd: input.selection.cwd || scratch,
    access: "none" as const,
  };
  const engine = getFunnel();
  const conversation =
    input.conversation && (!input.conversation.cliOnly || isToolProvider(selection.provider)) ? input.conversation : undefined;
  const tool = Boolean(conversation) && isToolProvider(selection.provider);
  const talk = conversation
    ? tool
      ? toolTalk(conversation.key, selection.provider)
      : conversationFor(conversation.key, selection, input.system)
    : undefined;
  // The session this turn goes on in: the chat's stored one when it ran on this tool in this folder, else (API and
  // local) the conversation core holds in memory.
  const stored = tool ? (conversation!.session ?? undefined) : undefined;
  let resumeId: string | undefined = tool
    ? conversation!.session === undefined
      ? talk?.sessionId
      : stored && stored.provider === selection.provider && stored.cwd === selection.cwd
        ? stored.id
        : undefined
    : talk?.sessionId;
  // A call outside a conversation has no next turn, so the tool is asked not to keep it in the student's own history.
  // Antigravity cannot do that (`capabilities.ephemeral`), and cli-funnel refuses the run if asked.
  const persist = !conversation && engine.providers[selection.provider]?.capabilities.ephemeral ? { persist: false as const } : {};
  const cache =
    input.cache && engine.providers[selection.provider]?.capabilities.cache;
  if (talk) talk.busy = true;
  let sessionId: string | undefined;
  let finished = false;
  let continued = false;
  // Debug mode records the call in its job's log, with the engine's own lines (cli-funnel's `verbose`).
  const scope = currentUsageScope();
  const access = selection.provider === "ollama" ? "local" : selection.provider.endsWith("-api") ? "api-key" : "subscription";
  let text = "";
  // Pyxis's tools go with the run when the answering tool takes them. They are the same for every turn of the chat (one
  // token per chat, see `tools/server.ts`), so the live process cli-funnel keeps between questions is reused.
  let servers =
    input.tools && toolsAttach(selection.provider)
      ? {
          [TOOL_SERVER]: {
            type: "http" as const,
            url: input.tools.url,
            headers: { Authorization: `Bearer ${input.tools.token}` },
          },
        }
      : undefined;
  try {
    for (;;) {
      const continuing = Boolean(resumeId) && Boolean(conversation);
      const prompt = continuing ? conversation!.followUp : input.prompt;
      const log = startCall(scope?.jobId, {
        provider: selection.provider,
        model: selection.model,
        access,
        ...(scope?.kind ? { kind: scope.kind } : {}),
        prompt,
        ...(input.system ? { system: input.system } : {}),
      });
      text = "";
      // Antigravity's message is held back while it may be its quota notice (see `mayBeAgyQuota`). Each message after a
      // tool call is held like the first, from where it starts in `text`.
      let holding = selection.provider === "antigravity";
      let message = 0;
      // The chunks the current message came in, and whether a tool call came before it.
      let chunks = 0;
      let called = false;
      // A call reached Pyxis's server in this attempt (see `toolsRefused`).
      let reached = false;
      const following = trackCall(scope?.jobId);
      try {
        const stream = engine.stream({
          selection,
          prompt,
          system: input.system,
          responseSchema: input.responseSchema,
          attachments: input.attachments,
          signal: input.signal,
          workspaceName: WORKSPACE_NAME,
          ...persist,
          ...(continuing ? { sessionId: resumeId } : {}),
          ...(cache ? { cache: true } : {}),
          ...(log ? { verbose: true } : {}),
          ...(servers ? { mcpServers: servers } : {}),
        });
        // The calls to Pyxis's own server, by the id the tool gave them, so their end is told with their name.
        const ours = new Map<string, string>();
        for await (const event of stream) {
          log?.event(event);
          following.event(event.type);
          if (event.type === "tool.start" && selection.provider === "antigravity") {
            // Held text before a call is not the notice: the call came after it. It goes out before the chat hears of the
            // call, so the call's place follows it, and the next message is held like the first. A call's end is only
            // its status.
            if (holding && text.length > message) input.onDelta?.(text);
            holding = true;
            message = text.length;
            chunks = 0;
            called = true;
          }
          if (event.type === "tool.start" && event.mcp?.server === TOOL_SERVER) reached = true;
          if (event.type === "tool.start" && event.mcp?.server === TOOL_SERVER && !event.parentId) {
            ours.set(event.id, event.mcp.tool);
            input.tools?.onTool?.({ phase: "start", id: event.id, tool: event.mcp.tool });
          }
          if (event.type === "tool.end" && ours.has(event.id))
            input.tools?.onTool?.({ phase: "end", id: event.id, tool: ours.get(event.id)!, ...(event.error ? { failed: true } : {}) });
          if (event.type === "session") {
            // A tool that resumes reports the id it was given. Another id means it started a new session, and this turn
            // would answer without the conversation: stop it and send the whole prompt instead.
            if (continuing && tool && event.sessionId !== resumeId) throw new SessionReplaced();
            sessionId = event.sessionId;
            if (tool) conversation!.onSession?.(event.sessionId, selection.provider, selection.cwd, Boolean(servers));
          }
          if (event.type !== "text.delta") continue;
          text += event.text;
          chunks += 1;
          // Antigravity's quota notice must not reach the screen as part of a reply: the message waits while it may
          // still be the notice, and goes out whole once it cannot.
          if (holding && mayBeAgyQuota(text.slice(message))) continue;
          holding = false;
          input.onDelta?.(text);
        }
        const result = await stream.result;
        const spent = () =>
          reportUsage({
            text: "",
            model: result.model,
            provider: result.provider,
            inputTokens: result.usage?.inputTokens ?? 0,
            outputTokens: result.usage?.outputTokens ?? 0,
            cacheReadTokens: result.usage?.cachedInputTokens ?? 0,
            cacheWriteTokens: result.usage?.cacheCreationInputTokens ?? 0,
          });
        // Live Codex ends a stopped turn with a cancelled result, and a CLI killed on Stop can report what it printed as a
        // finished answer. Either way the student stopped it.
        if (result.finishReason === "cancelled" || input.signal?.aborted) {
          // The tokens of a turn the student stopped were spent all the same. Codex and Antigravity report them for a
          // cancelled turn; Claude Code reports none, and then nothing is recorded.
          spent();
          throw new DOMException("Engine turn cancelled", "AbortError");
        }
        const quota = antigravityQuota(
          selection.provider,
          text ? text.slice(message) : result.text,
          result.usage,
          called && (!text || chunks === 1),
        );
        if (quota) {
          // A turn that ran out mid-way reports what it spent before the notice.
          spent();
          throw quota;
        }
        // A message that ended while it still looked like the notice, and is not it, is shown now.
        if (holding && text.length > message) input.onDelta?.(text);
        finished = true;
        continued = continuing;
        following.end();
        log?.end({
          text: result.text || text,
          ...(result.finishReason ? { finishReason: result.finishReason } : {}),
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
        });
        if (talk) {
          talk.sessionId = result.sessionId ?? sessionId ?? talk.sessionId;
          talk.chars += prompt.length + (result.text || text).length;
          talk.lastUsed = Date.now();
        }
        return {
          text: result.text || text,
          model: result.model,
          provider: result.provider,
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
          cacheReadTokens: result.usage?.cachedInputTokens ?? 0,
          cacheWriteTokens: result.usage?.cacheCreationInputTokens ?? 0,
          structured: result.structured,
          structuredError: result.structuredError,
          finishReason: result.finishReason,
          ...(tool && (result.sessionId ?? sessionId)
            ? {
                sessionId: result.sessionId ?? sessionId,
                cwd: selection.cwd,
                continued,
              }
            : {}),
          ...(servers ? { tools: true } : {}),
        };
      } catch (err) {
        following.end();
        log?.end({ text, error: input.signal?.aborted ? "cancelled" : err instanceof Error ? err.message : String(err) });
        // The tool no longer holds the stored session (the student cleared its history, or it was moved): the chat
        // starts a new one with the whole earlier conversation, which `prompt` carries.
        if (continuing && tool && !text && !input.signal?.aborted && (err instanceof SessionReplaced || isSessionGone(err))) {
          resumeId = undefined;
          sessionId = undefined;
          continue;
        }
        // The tools were refused before anything was written or called: the same turn runs again without them, and this
        // tool is not offered them again until core restarts.
        if (servers && !text && !reached && !input.signal?.aborted && toolsRefused(err)) {
          servers = undefined;
          markToolsRefused(selection.provider);
          continue;
        }
        if (reached && err && typeof err === "object") Object.assign(err, { toolsReached: true });
        throw err;
      }
    }
  } finally {
    if (talk) {
      talk.busy = false;
      if (!talk.sessionId) talk.sessionId = sessionId;
      // An API or local conversation left in an unknown state by a stopped or failed turn starts over. A CLI session
      // is kept: the tool holds what it holds, and the next turn tells it what the student saw.
      if ((!finished && !tool) || talk.leaving) endConversation(conversation!.key);
    } else if (sessionId && engine.sessionsEnabled) {
      // A run outside a chat has no next turn, so its process does not wait out the idle time.
      engine.closeSession(sessionId, selection.provider);
    }
  }
}
