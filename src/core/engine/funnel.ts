import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { currentUsageScope, reportUsage } from "./usage";
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
  /** For Cursor Agent: its own folder holds the chat after this turn, so a later absence means the student cleared it. */
  seen?: boolean;
  /** The turn went on in the stored session. False when it started a new one (another tool, a folder that changed, a session the tool no longer knew). */
  continued?: boolean;
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
  if (!funnel)
    funnel = createFunnel({
      providers: Object.fromEntries(apiIds.map((id) => [id, apiProvider(id)])),
      // Claude Code and Codex keep a chat's process between questions. Other runs close theirs when they end.
      sessions: { keepAlive: true, idleMs: CONVERSATION_IDLE_MS },
      history,
      // A local model stays loaded as long as a chat's conversation lasts, so a follow-up question does not reload it.
      ollama: { keepAlive: `${CONVERSATION_IDLE_MS / 60_000}m` },
    });
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
 * A chat, a lesson or a quiz hand-in on a subscription CLI (Claude Code, Codex, Cursor Agent, Antigravity) keeps its
 * session in the database and continues it by id, in a live process or in a new one. API providers and Ollama keep their conversation as history
 * in this process.
 */
function isToolProvider(provider: ProviderId): boolean {
  return !provider.endsWith("-api") && provider !== "ollama";
}

/** Cursor Agent gets `system` as a block at the start of the prompt, so a turn in a session it holds leaves it out. The other tools take it on every call, Antigravity in its session's system slot. */
export function systemInPrompt(provider: string): boolean {
  return provider === "agent";
}

/** The folder name that keeps Pyxis's chats apart from every other app's in Cursor's and Antigravity's history. */
const WORKSPACE_NAME = "pyxis";

/**
 * The CLIs word the failure of a resume differently: Claude Code "No conversation found with session ID", Codex "no
 * rollout found for thread id", Antigravity "Conversation ... was not found". Cursor Agent starts a new chat without a
 * word, so a session it lost cannot be told from one it holds.
 */
const SESSION_GONE = /no conversation found|no rollout found|conversation .{0,80}was not found|session .{0,80}not found/i;

export function isSessionGone(err: unknown): boolean {
  return SESSION_GONE.test(err instanceof Error ? err.message : String(err));
}

let cursorChats: string | null | undefined;
/** Tests point the check below at a folder of their own (null: none); undefined restores Cursor's own. */
export function setCursorChatsRoot(root: string | null | undefined): void {
  cursorChats = root;
}

/** Whether Cursor's chat folders hold the chat: `held`, `absent` (they hold other chats and not this one), or `unknown` (nothing there to read). */
export function cursorChatState(id: string): "held" | "absent" | "unknown" {
  const root = cursorChats === undefined ? join(homedir(), ".cursor", "chats") : cursorChats;
  if (!root || !/^[\w-]+$/.test(id)) return "unknown";
  try {
    const workspaces = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    if (workspaces.some((dir) => existsSync(join(root, dir.name, id)))) return "held";
    // Other chats must be there to say this one is gone: a workspace folder that holds a chat folder. A folder with only
    // files in it, or workspaces with nothing in them, is a layout this does not understand.
    const knowsChats = workspaces.some((dir) =>
      readdirSync(join(root, dir.name), { withFileTypes: true }).some((entry) => entry.isDirectory()),
    );
    return knowsChats ? "absent" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * True when Cursor Agent no longer holds the chat. Given an id it does not know, `agent --resume` answers as a new chat
 * under that same id, with the same `session_id` in every event, so nothing in the stream tells the loss: the reply comes
 * back as if the conversation had been there. Cursor keeps its chats in `~/.cursor/chats/<workspace>/<id>`. The chat is
 * gone when that folder holds other chats and none is this one. When it is missing or empty, which is also what another
 * layout looks like, the chat counts as held, unless it was seen there before (`seen`): a chat that was in the folder
 * and is not now was cleared by the student, who may have cleared everything.
 * shortcut: reads Cursor's private folder layout, checked on agent 2026.11.13; drop it when `agent` reports a lost resume.
 */
export function cursorSessionLost(id: string, seen = false): boolean {
  const state = cursorChatState(id);
  return state === "absent" || (seen && state === "unknown");
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
    session?: { provider: string; id: string; cwd: string; seen?: boolean } | null;
    onSession?: (sessionId: string, provider: string, cwd: string) => void;
    /**
     * Only a subscription CLI keeps this conversation. An API or local provider answers each call on its own, with the
     * whole prompt, because their history lives in this process, which a local model's small window cannot hold. A
     * lesson and a quiz hand-in set it.
     */
    cliOnly?: boolean;
  };
  /** Mark the system prompt and the conversation so far for the provider's prompt cache, where it has one. */
  cache?: boolean;
};

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
  // Cursor Agent answers a resume of a chat it lost as a new chat, so its folder says whether it still holds the session.
  if (tool && selection.provider === "agent" && resumeId && stored && cursorSessionLost(resumeId, stored.seen)) resumeId = undefined;
  // A call outside a conversation has no next turn, so the tool is asked not to keep it in the student's own history.
  // Cursor Agent and Antigravity cannot do that (`capabilities.ephemeral`), and cli-funnel refuses the run if asked.
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
  try {
    for (;;) {
      const continuing = Boolean(resumeId) && Boolean(conversation);
      const prompt = continuing ? conversation!.followUp : input.prompt;
      // The tool already holds the instructions the first prompt of a Cursor session carried.
      const system = continuing && systemInPrompt(selection.provider) ? undefined : input.system;
      const log = startCall(scope?.jobId, {
        provider: selection.provider,
        model: selection.model,
        access,
        ...(scope?.kind ? { kind: scope.kind } : {}),
        prompt,
        ...(system ? { system } : {}),
      });
      text = "";
      try {
        const stream = engine.stream({
          selection,
          prompt,
          system,
          responseSchema: input.responseSchema,
          attachments: input.attachments,
          signal: input.signal,
          workspaceName: WORKSPACE_NAME,
          ...persist,
          ...(continuing ? { sessionId: resumeId } : {}),
          ...(cache ? { cache: true } : {}),
          ...(log ? { verbose: true } : {}),
        });
        for await (const event of stream) {
          log?.event(event);
          if (event.type === "session") {
            // A tool that resumes reports the id it was given. Another id means it started a new session, and this turn
            // would answer without the conversation: stop it and send the whole prompt instead.
            if (continuing && tool && event.sessionId !== resumeId) throw new SessionReplaced();
            sessionId = event.sessionId;
            if (tool) conversation!.onSession?.(event.sessionId, selection.provider, selection.cwd);
          }
          if (event.type !== "text.delta") continue;
          text += event.text;
          input.onDelta?.(text);
        }
        const result = await stream.result;
        // Live Codex ends a stopped turn with a cancelled result, and a CLI killed on Stop can report what it printed as a
        // finished answer. Either way the student stopped it.
        if (result.finishReason === "cancelled" || input.signal?.aborted) {
          // The tokens of a turn the student stopped were spent all the same. Codex and Antigravity report them for a
          // cancelled turn; Claude Code and Cursor Agent report none, and then nothing is recorded.
          reportUsage({
            text: "",
            model: result.model,
            provider: result.provider,
            inputTokens: result.usage?.inputTokens ?? 0,
            outputTokens: result.usage?.outputTokens ?? 0,
            cacheReadTokens: result.usage?.cachedInputTokens ?? 0,
            cacheWriteTokens: result.usage?.cacheCreationInputTokens ?? 0,
          });
          throw new DOMException("Engine turn cancelled", "AbortError");
        }
        finished = true;
        continued = continuing;
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
                ...(selection.provider === "agent" ? { seen: cursorChatState(result.sessionId ?? sessionId!) === "held" } : {}),
              }
            : {}),
        };
      } catch (err) {
        log?.end({ text, error: input.signal?.aborted ? "cancelled" : err instanceof Error ? err.message : String(err) });
        // The tool no longer holds the stored session (the student cleared its history, or it was moved): the chat
        // starts a new one with the whole earlier conversation, which `prompt` carries.
        if (continuing && tool && !text && !input.signal?.aborted && (err instanceof SessionReplaced || isSessionGone(err))) {
          resumeId = undefined;
          sessionId = undefined;
          continue;
        }
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
