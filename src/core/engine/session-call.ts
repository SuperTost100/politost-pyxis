import type Database from "better-sqlite3";
import { contextHash, currentSession, keepSession, markOutOfStep, recordSession } from "../chat/sessions";
import { generate, type GenerateInput, type GenerateOutput } from "./generate";

/**
 * Work that is not a chat but is one conversation with a tool: the outline and the parts of one lesson, the open answers
 * of one quiz hand-in. It uses the chat's session store (`chat/sessions.ts`) and its rule for when a session is in step,
 * keyed by an owner that is not a chat: `lesson:<topic id>`, `quiz:<attempt id>`. See "Chat sessions and prompt
 * caching" and "Lessons and hand-ins in one session" in docs/engines.md.
 */

/** The owners whose session a call holds right now. */
const busy = new Set<string>();

/** What one call on the session needs, on top of what `generate()` takes. */
export type SessionCall = Omit<GenerateInput, "prompt" | "promptFor" | "followUpFor" | "conversation" | "cache"> & {
  /** The whole message, for a call that starts a session, runs on a tool that keeps none, or finds its session lost. */
  fresh: string;
  /** The message for a session that holds what came before: only what is new. */
  followUp: string;
  /**
   * `followUp` is about the previous call of this scope (its problems, its reply), so it only makes sense in the session
   * that received that call's request and reply. When that call was answered by an engine that keeps no session (an API
   * provider, a local model), or the session was lost, the call goes to a new session with `fresh` instead.
   */
  continuesLast?: boolean;
};

export type SessionHandle = {
  /**
   * True when the open session holds the owner as of `state`: the last thing done on it was kept (see `keep`) at that
   * same state, and it was opened under `system`. With no session, after a stop or a failure, or when the owner has
   * changed since (another writer wrote a part, a section was rewritten on its own), it is false, and the message to
   * send then says what the owner holds. An owner with no state of its own (a quiz hand-in, whose messages stand
   * alone) leaves `state` out and asks only whether a session is open and in step.
   */
  inStep(state?: string, system?: string): boolean;
  /** A call on the session. A tool that keeps none, or an API or local provider, answers it from `fresh`. */
  generate(call: SessionCall): Promise<GenerateOutput>;
  /**
   * The owner is, for the session, as `state` says: the call completed and its result was saved. `state` is what the
   * session knows, which is what the caller sent it plus the reply it saved, not whatever the owner holds by now.
   */
  keep(state: string): void;
};

/**
 * Runs `body` with the owner's session. The session is marked out of step when `body` starts and is in step again only
 * through `keep`, which `body` calls once its result is saved, so a call that fails, is stopped or is not kept leaves it
 * out of step with no case of its own.
 *
 * A session the tool opens is stored the moment the tool names it, so a call that is stopped leaves a session to
 * continue. One the tool no longer holds is replaced by a new one, which gets `fresh`. So is one opened under another
 * system prompt than the call's: Claude Code, Codex and Antigravity all went on answering by the first prompt of a
 * session when a resumed call gave another (checked with a rule in each prompt, 2026-11-20), so a call that needs its own
 * rules needs its own session.
 *
 * Two calls on one session at once would each continue it from the same point, so a call that finds the session in use
 * runs on its own instead, as a one-shot with `fresh`, and keeps nothing: the student who asks for a part while another
 * is being written does not wait for it. The session is then behind the lesson, and the next call says what it holds.
 */
export async function withSession<T>(db: Database.Database, owner: string, body: (session: SessionHandle) => Promise<T>): Promise<T> {
  if (busy.has(owner)) {
    return body({
      inStep: () => false,
      keep: () => undefined,
      generate: (call) => {
        const { fresh, followUp: _followUp, ...rest } = call;
        return generate({ ...rest, prompt: fresh, cache: true });
      },
    });
  }
  busy.add(owner);
  try {
    const before = currentSession(db, owner);
    const stepped = Boolean(before?.inStep);
    const state = before?.syncedTo ?? undefined;
    markOutOfStep(db, owner);
    let answeredBy: string | undefined;
    /** Whether the last call of this scope was answered in a tool session, which then holds its request and its reply. */
    let lastHeld: boolean | undefined;
    const handle: SessionHandle = {
      inStep: (now, system) =>
        stepped &&
        (now === undefined || state === now) &&
        (system === undefined || !before?.instructions || before.instructions === contextHash(system)),
      keep: (marker) => {
        if (answeredBy) keepSession(db, owner, answeredBy, marker);
      },
      async generate(call) {
        const { fresh, followUp, continuesLast, ...rest } = call;
        const instructions = contextHash(call.system ?? "");
        const held = currentSession(db, owner);
        // A session opened under other instructions cannot take these: it is left, and a new one starts with `fresh`.
        const other = held && held.instructions && held.instructions !== instructions;
        // A follow-up about the previous call needs the session that holds that call; if an engine without a session
        // answered it, the stored one never saw it.
        const stale = continuesLast === true && lastHeld === false;
        const open = other || stale ? undefined : held;
        const store = (
          sessionId: string,
          provider: string,
          cwd: string,
          at: { model: string; effort: string | null; chars: number; finished: boolean },
        ) =>
          recordSession(
            db,
            owner,
            currentSession(db, owner),
            {
              provider,
              sessionId,
              cwd,
              model: at.model,
              effort: at.effort,
              told: "",
              instructions,
              chars: at.chars,
              now: Date.now(),
              finished: at.finished,
              syncedTo: null,
            },
            other ? "instructions" : "gone",
          );
        let answering: { model: string; effort?: string } = call.selection;
        const result = await generate({
          ...rest,
          prompt: fresh,
          // The follow-up replaces the prompt only when the session continues, on the tool that holds it.
          followUpFor: () => followUp,
          onEngine: (engine) => {
            answering = engine;
            call.onEngine?.(engine);
          },
          conversation: {
            key: owner,
            followUp: "",
            cliOnly: true,
            session: open ? { provider: open.provider, id: open.sessionId, cwd: open.cwd } : null,
            onSession: (sessionId, provider, cwd) => {
              const now = currentSession(db, owner);
              if (now?.provider === provider && now.sessionId === sessionId) return;
              store(sessionId, provider, cwd, { model: answering.model, effort: answering.effort ?? null, chars: 0, finished: false });
            },
          },
          cache: true,
        });
        lastHeld = Boolean(result.sessionId && result.cwd);
        if (result.sessionId && result.cwd) {
          answeredBy = result.provider;
          store(result.sessionId, result.provider, result.cwd, {
            model: result.model,
            effort: answering.effort ?? null,
            chars: (result.continued ? followUp : fresh).length + result.text.length,
            finished: true,
          });
          // A session opened by this call's end is in step only through `keep`, like one the tool named at its start.
          markOutOfStep(db, owner);
        } else answeredBy = undefined;
        return result;
      },
    };
    return await body(handle);
  } finally {
    busy.delete(owner);
  }
}
