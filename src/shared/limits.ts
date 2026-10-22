// Plain values the renderer needs at startup. They live outside ipc.ts so that importing one does not pull the whole
// Zod contract into the first bundle; ipc.ts builds its schemas from them.

/** Engines Pyxis offers. Each one runs in CLI Funnel's text-only mode. */
export const engineProviders = [
  "claude",
  "codex",
  "agent",
  "antigravity",
  "anthropic-api",
  "openai-api",
] as const;
export type EngineProvider = (typeof engineProviders)[number];

/**
 * Longest text the tutor takes. A pasted page of notes is about 3,000 characters, so 20,000 leaves room for several,
 * and a longer paste is refused with a message in the chat instead of failing as a vague engine error. The same
 * numbers limit the Ask composer, so the student sees them before sending.
 */
export const CHAT_TEXT_MAX = 20_000;
/** The pinned body of a chat started from an answer or a passage. It is sent again with every turn. */
export const CHAT_SEED_BODY_MAX = 20_000;
export const CHAT_TITLE_MAX = 200;
/** Profile text reaches every system prompt, so each field is short. */
export const PROFILE_LIMITS = {
  displayName: 100,
  year: 60,
  school: 120,
  course: 120,
  language: 40,
  interest: 60,
  interests: 20,
} as const;
