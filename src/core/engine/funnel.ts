import type Database from "better-sqlite3";
import tiers from "../../../resources/model-tiers.json";
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
} from "cli-funnel";

export type { ProviderId, Selection };
export { FunnelError };
import { clearSignOut } from "./bench";
import { shellPathReady } from "./shell-path";
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
};

type Keys = { anthropic?: string; openai?: string };
const apiIds = ["anthropic-api", "openai-api"] as const;
type ApiId = (typeof apiIds)[number];
const vendorOf = (id: ApiId) =>
  id === "anthropic-api" ? "anthropic" : "openai";

/** A chat's conversation ends after this long without a question, and its CLI process with it. */
export const CONVERSATION_IDLE_MS = 10 * 60_000;
/** Characters a conversation may carry. Past this the next question starts a new one with the recent turns only. */
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

/** The provider's own name, such as "Claude Code", for notices. */
export function providerName(id: string): string {
  return getFunnel().providers[id as ProviderId]?.displayName ?? id;
}

type Conversation = {
  provider: ProviderId;
  /** Engine and system prompt the conversation started with. A change starts a new one. */
  fingerprint: string;
  sessionId?: string;
  chars: number;
  lastUsed: number;
  busy: boolean;
  /** The chat was left while a turn ran; the conversation ends when the turn does. */
  leaving: boolean;
};

const conversations = new Map<string, Conversation>();

/**
 * Providers that keep a conversation between turns: Claude Code and Codex in a live process, the API providers and
 * Ollama as history in this process. Cursor Agent and Antigravity start a new process for every turn and get the whole prompt.
 */
function keepsConversation(provider: ProviderId): boolean {
  return (
    provider.endsWith("-api") ||
    provider === "ollama" ||
    Boolean(getFunnel().providers[provider]?.openSession)
  );
}

/** Ends a chat's conversation and stops its CLI process. A turn still running finishes first. */
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

/** Ends every chat's conversation, for example after the student changed engines. */
export function endConversations(): void {
  for (const key of [...conversations.keys()]) endConversation(key);
}

/** Stops every live CLI process, when the app quits. */
export function closeFunnel(): void {
  conversations.clear();
  funnel?.close();
}

/** The chat's conversation when it can go on with this engine and system prompt, else a new one. */
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
   * `followUp` (the new question and its passages) continues one the engine still holds.
   */
  conversation?: { key: string; followUp: string };
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
  return (
    tiers as unknown as {
      local: { tiers: Array<{ model: string; contextWindow: number }> };
    }
  ).local.tiers.find((tier) => tier.model === model)?.contextWindow;
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
  const talk = input.conversation
    ? conversationFor(input.conversation.key, selection, input.system)
    : undefined;
  const continuing = Boolean(talk?.sessionId);
  const prompt =
    continuing && input.conversation ? input.conversation.followUp : input.prompt;
  const cache =
    input.cache && engine.providers[selection.provider]?.capabilities.cache;
  if (talk) talk.busy = true;
  let sessionId: string | undefined;
  let finished = false;
  try {
    const stream = engine.stream({
      selection,
      prompt,
      system: input.system,
      responseSchema: input.responseSchema,
      attachments: input.attachments,
      signal: input.signal,
      ...(continuing ? { sessionId: talk!.sessionId } : {}),
      ...(cache ? { cache: true } : {}),
    });
    let text = "";
    for await (const event of stream) {
      if (event.type === "session") sessionId = event.sessionId;
      if (event.type !== "text.delta") continue;
      text += event.text;
      input.onDelta?.(text);
    }
    const result = await stream.result;
    // Live Codex ends a stopped turn with a cancelled result, and a CLI killed on Stop can report what it printed as a
    // finished answer. Either way the student stopped it.
    if (result.finishReason === "cancelled" || input.signal?.aborted)
      throw new DOMException("Engine turn cancelled", "AbortError");
    finished = true;
    if (talk && finished) {
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
    };
  } finally {
    if (talk) {
      talk.busy = false;
      if (!talk.sessionId) talk.sessionId = sessionId;
      // A stopped or failed turn leaves the conversation in an unknown state, so the next question starts over.
      if (!finished || talk.leaving) endConversation(input.conversation!.key);
    } else if (sessionId && engine.sessionsEnabled) {
      // A run outside a chat has no next turn, so its process does not wait out the idle time.
      engine.closeSession(sessionId, selection.provider);
    }
  }
}
