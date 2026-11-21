import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { currentSession, sessionsOpened } from "../chat/sessions";
import type { EngineResult } from "./funnel";
import { withSession } from "./session-call";

type Seen = {
  prompt: string;
  followUp?: string;
  session?: { provider: string; id: string; cwd: string } | null;
  conversation: boolean;
  system?: string;
};

const selection = { provider: "claude" as const, model: "m" };

/** A database with the topics and the attempt the owners below belong to, and a chat. */
function database() {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('p', 'Fisica', 'ready', 1, 1);
    INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t1', 'p', 'Moto', 0, 1), ('t2', 'p', 'Forze', 1, 1);
    INSERT INTO attempts (id, plan_id, started_at) VALUES ('a1', 'p', 1);
    INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c1', 'uno', 1, 1);
  `);
  return db;
}

/** A tool that keeps what it is told: it continues the session it is given and opens a new one when it gets none. */
function tool(options: { provider?: string; lose?: boolean; after?: number } = {}) {
  const seen: Seen[] = [];
  let opened = options.after ?? 0;
  return {
    seen,
    run: (async (input: {
      prompt: string;
      system?: string;
      conversation?: { followUp: string; session?: { provider: string; id: string; cwd: string } | null; onSession?: (id: string, provider: string, cwd: string) => void };
    }) => {
      seen.push({
        prompt: input.prompt,
        followUp: input.conversation?.followUp,
        session: input.conversation?.session,
        conversation: Boolean(input.conversation),
        system: input.system,
      });
      const provider = options.provider ?? "claude";
      const held = input.conversation?.session;
      const continued = Boolean(held) && !options.lose;
      const id = continued ? held!.id : `s-${(opened += 1)}`;
      if (input.conversation) input.conversation.onSession?.(id, provider, "/scratch");
      return {
        text: "ok",
        model: "m",
        provider,
        inputTokens: 1,
        ...(input.conversation ? { sessionId: id, cwd: "/scratch", continued } : {}),
      } satisfies EngineResult;
    }) as never,
  };
}

const call = (run: unknown, fresh: string, followUp: string) => ({ selection, run: run as never, system: "rules", fresh, followUp });

describe("a session for work that is not a chat", () => {
  it("opens a session on the first call, sends the whole message, and keeps it as stored", async () => {
    const db = database();
    const t = tool();
    await withSession(db, "lesson:t1", async (session) => {
      expect(session.inStep("v0")).toBe(false);
      await session.generate(call(t.run, "whole", "next"));
      session.keep("v1");
    });
    expect(t.seen[0]).toMatchObject({ prompt: "whole", session: null, conversation: true, system: "rules" });
    expect(currentSession(db, "lesson:t1")).toMatchObject({ provider: "claude", sessionId: "s-1", cwd: "/scratch", inStep: true, syncedTo: "v1" });
    expect(sessionsOpened(db, "lesson:t1")).toBe(1);
    db.close();
  });

  it("continues the stored session, and says it is in step only at the state it was kept at", async () => {
    const db = database();
    const t = tool();
    await withSession(db, "lesson:t1", async (session) => {
      await session.generate(call(t.run, "whole", "next"));
      session.keep("v1");
    });
    await withSession(db, "lesson:t1", async (session) => {
      expect(session.inStep("v1")).toBe(true);
      // The lesson changed since (another writer, a section rewritten on its own): the session is behind.
      expect(session.inStep("v2")).toBe(false);
      // An owner with no state of its own asks only whether the last call was kept.
      expect(session.inStep()).toBe(true);
      await session.generate(call(t.run, "whole again", "next one"));
      session.keep("v2");
    });
    expect(t.seen[1]).toMatchObject({ session: { provider: "claude", id: "s-1", cwd: "/scratch" }, followUp: "next one" });
    expect(sessionsOpened(db, "lesson:t1")).toBe(1);
    expect(currentSession(db, "lesson:t1")).toMatchObject({ inStep: true, syncedTo: "v2" });
    db.close();
  });

  it("leaves the session out of step when the call fails, is stopped, or its result is not kept", async () => {
    const db = database();
    const t = tool();
    await withSession(db, "quiz:a1", async (session) => {
      await session.generate(call(t.run, "whole", "next"));
      session.keep("q1");
    });
    // The call fails: the session stays stored, and is not in step.
    await expect(
      withSession(db, "quiz:a1", async (session) => {
        await session.generate({ ...call(t.run, "whole", "next"), run: (() => Promise.reject(new Error("offline"))) as never });
      }),
    ).rejects.toThrow("offline");
    expect(currentSession(db, "quiz:a1")).toMatchObject({ sessionId: "s-1", inStep: false });
    await withSession(db, "quiz:a1", async (session) => {
      expect(session.inStep()).toBe(false);
      // A call that completed but whose result was not saved leaves it out of step too.
      await session.generate(call(t.run, "whole", "next"));
    });
    expect(currentSession(db, "quiz:a1")).toMatchObject({ inStep: false });
    db.close();
  });

  it("leaves the session out of step when a call fails after an earlier call of the same scope was kept", async () => {
    const db = database();
    const t = tool();
    await expect(
      withSession(db, "lesson:t1", async (session) => {
        await session.generate(call(t.run, "whole", "next"));
        session.keep("v1");
        // The session now holds a request whose result is never kept.
        await session.generate({ ...call(t.run, "whole", "next"), run: (() => Promise.reject(new Error("offline"))) as never });
      }),
    ).rejects.toThrow("offline");
    expect(currentSession(db, "lesson:t1")).toMatchObject({ sessionId: "s-1", inStep: false, syncedTo: "v1" });
    await withSession(db, "lesson:t1", async (session) => {
      expect(session.inStep("v1")).toBe(false);
      expect(session.kept).toBe("v1");
    });
    db.close();
  });

  it("stores the session the moment the tool names it, so a call that is stopped leaves one to continue", async () => {
    const db = database();
    const controller = new AbortController();
    const run = (async (input: { conversation?: { onSession?: (id: string, provider: string, cwd: string) => void } }) => {
      input.conversation?.onSession?.("named", "claude", "/scratch");
      controller.abort();
      throw new DOMException("stopped", "AbortError");
    }) as never;
    await expect(
      withSession(db, "lesson:t1", (session) => session.generate({ ...call(run, "whole", "next"), signal: controller.signal })),
    ).rejects.toThrow();
    expect(currentSession(db, "lesson:t1")).toMatchObject({ sessionId: "named", inStep: false });
    db.close();
  });

  it("opens a new session when the tool lost the stored one, and ends the old with the reason", async () => {
    const db = database();
    await withSession(db, "lesson:t1", async (session) => {
      await session.generate(call(tool().run, "whole", "next"));
      session.keep("v1");
    });
    const lost = tool({ lose: true, after: 6 });
    await withSession(db, "lesson:t1", async (session) => {
      expect(session.inStep("v1")).toBe(true);
      await session.generate(call(lost.run, "whole", "next"));
    });
    expect(currentSession(db, "lesson:t1")).toMatchObject({ sessionId: "s-7", inStep: false });
    expect(sessionsOpened(db, "lesson:t1")).toBe(2);
    expect(db.prepare("SELECT ended_reason FROM tool_sessions WHERE owner = 'lesson:t1' AND ended_at IS NOT NULL").pluck().all()).toEqual(["gone"]);
    db.close();
  });

  it("ends the session when another tool answers, and opens that tool's", async () => {
    const db = database();
    await withSession(db, "lesson:t1", async (session) => {
      await session.generate(call(tool().run, "whole", "next"));
      session.keep("v1");
    });
    await withSession(db, "lesson:t1", async (session) => {
      await session.generate(call(tool({ provider: "codex" }).run, "whole", "next"));
      session.keep("v1");
    });
    expect(db.prepare("SELECT provider, ended_reason FROM tool_sessions WHERE owner = 'lesson:t1' ORDER BY opened_at, rowid").all()).toEqual([
      { provider: "claude", ended_reason: "tool" },
      { provider: "codex", ended_reason: null },
    ]);
    db.close();
  });

  it("starts a new session when the call has other rules than the session was opened under, and ends the old one", async () => {
    const db = database();
    const t = tool();
    await withSession(db, "lesson:t1", async (session) => {
      await session.generate(call(t.run, "whole", "next"));
      session.keep("v1");
    });
    await withSession(db, "lesson:t1", async (session) => {
      expect(session.inStep("v1", "rules")).toBe(true);
      expect(session.inStep("v1", "other rules")).toBe(false);
      await session.generate({ ...call(t.run, "whole", "next"), system: "other rules" });
    });
    // The tool was given no session to continue: it would have gone on by the rules of the first.
    expect(t.seen[1]).toMatchObject({ session: null, prompt: "whole", system: "other rules" });
    expect(db.prepare("SELECT session_id, ended_reason FROM tool_sessions WHERE owner = 'lesson:t1' ORDER BY opened_at, rowid").all()).toEqual([
      { session_id: "s-1", ended_reason: "instructions" },
      { session_id: "s-2", ended_reason: null },
    ]);
    db.close();
  });

  it("keeps each owner's session apart", async () => {
    const db = database();
    const t = tool();
    await withSession(db, "lesson:t1", async (session) => {
      await session.generate(call(t.run, "a", "a"));
      session.keep("v1");
    });
    await withSession(db, "lesson:t2", async (session) => {
      expect(session.inStep("v1")).toBe(false);
      await session.generate(call(t.run, "b", "b"));
    });
    expect(currentSession(db, "lesson:t1")!.sessionId).not.toBe(currentSession(db, "lesson:t2")!.sessionId);
    db.close();
  });

  it("runs a call that finds the session in use on its own, as a call the tool does not keep, and leaves the session behind", async () => {
    const db = database();
    const t = tool();
    const alone = tool();
    await withSession(db, "lesson:t1", async (session) => {
      await session.generate(call(t.run, "whole", "next"));
      session.keep("v1");
    });
    await withSession(db, "lesson:t1", async (first) => {
      // A second writer starts while the first is writing: it does not wait, and does not touch the session.
      await withSession(db, "lesson:t1", async (second) => {
        expect(second.inStep("v1")).toBe(false);
        await second.generate(call(alone.run, "whole, for the one beside", "unused"));
        second.keep("v-second");
      });
      await first.generate(call(t.run, "whole", "next"));
      first.keep("v1-plus-first");
    });
    expect(alone.seen[0]).toMatchObject({ prompt: "whole, for the one beside", conversation: false });
    expect(sessionsOpened(db, "lesson:t1")).toBe(1);
    // The session knows what the first writer told it, not what the second saved: the lesson is at another state.
    expect(currentSession(db, "lesson:t1")).toMatchObject({ syncedTo: "v1-plus-first" });
    // The session is free again once both end.
    await withSession(db, "lesson:t1", async (session) => {
      expect(session.inStep("v1-plus-first")).toBe(true);
    });
    db.close();
  });

  it("frees the session when the body throws", async () => {
    const db = database();
    await expect(withSession(db, "lesson:t1", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    const t = tool();
    await withSession(db, "lesson:t1", (session) => session.generate(call(t.run, "whole", "next")));
    expect(t.seen[0]!.conversation).toBe(true);
    db.close();
  });

  it.each([
    ["a lesson", "lesson:t1", "DELETE FROM topics WHERE id = 't1'"],
    ["a quiz hand-in", "quiz:a1", "DELETE FROM attempts WHERE id = 'a1'"],
    ["a chat", "c1", "DELETE FROM chats WHERE id = 'c1'"],
  ])("leaves no row behind for %s that was deleted while its call ran", async (_name, owner, remove) => {
    const db = database();
    const t = tool();
    await withSession(db, owner, async (session) => {
      const call$ = session.generate({
        ...call(t.run, "whole", "next"),
        run: (async (input: { conversation?: { onSession?: (id: string, provider: string, cwd: string) => void } }) => {
          // The tool names its session, then the owner is deleted before the call ends.
          input.conversation?.onSession?.("named", "claude", "/scratch");
          db.exec(remove);
          return { text: "ok", model: "m", provider: "claude", inputTokens: 1, sessionId: "named", cwd: "/scratch", continued: false };
        }) as never,
      });
      await call$;
      session.keep("v1");
    });
    expect(db.prepare("SELECT COUNT(*) FROM tool_sessions WHERE owner = ?").pluck().get(owner)).toBe(0);
    db.close();
  });

  it("sends a follow-up about the previous call to the session that holds it, and to a new one when no session answered", async () => {
    const db = database();
    const t = tool();
    // An engine that keeps no session: no session id comes back.
    const api = (async () => ({ text: "bad", model: "m", provider: "anthropic-api", inputTokens: 1 })) as never;
    await withSession(db, "lesson:t1", async (session) => {
      await session.generate(call(t.run, "whole", "next"));
      session.keep("v1");
    });
    // The first call is answered in the stored session: the follow-up resumes it.
    await withSession(db, "lesson:t1", async (session) => {
      await session.generate(call(t.run, "whole", "request"));
      await session.generate({ ...call(t.run, "whole + problems", "problems only"), continuesLast: true });
      session.keep("v2");
    });
    expect(t.seen.at(-1)).toMatchObject({ session: { id: "s-1" }, followUp: "problems only" });
    // The first call is answered by an engine without a session: the stored one never saw the request or the reply.
    await withSession(db, "lesson:t1", async (session) => {
      await session.generate({ ...call(api, "whole", "request") });
      await session.generate({ ...call(t.run, "whole + problems", "problems only"), continuesLast: true });
      // And the session that answered holds the part it produced, not one it did not see.
    });
    expect(t.seen.at(-1)).toMatchObject({ session: null, prompt: "whole + problems" });
    db.close();
  });

  it("does not mark the session as holding a result an engine without a session produced", async () => {
    const db = database();
    const t = tool();
    const api = (async () => ({ text: "ok", model: "m", provider: "anthropic-api", inputTokens: 1 })) as never;
    await withSession(db, "lesson:t1", async (session) => {
      await session.generate(call(t.run, "whole", "next"));
      session.keep("v1");
    });
    await withSession(db, "lesson:t1", async (session) => {
      await session.generate(call(api, "whole", "next"));
      session.keep("v2");
    });
    // The stored session did not write v2: it is out of step at v1.
    expect(currentSession(db, "lesson:t1")).toMatchObject({ inStep: false, syncedTo: "v1" });
    db.close();
  });
});
