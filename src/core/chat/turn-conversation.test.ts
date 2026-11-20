import { describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { openDatabase } from "../db/connection";
import type { EngineResult } from "../engine/funnel";
import { saveProfile } from "../profile/profile";
import { importSmartbook } from "../sources/smartbook";
import { benchEngine, clearBench } from "../engine/bench";
import { rememberReady } from "../engine/selection";
import { askTurn, clearChatContext, readChat, regenerateTurn, settleChecks } from "./turn";
import { currentSession, sessionsOpened, UNCOMPACTED_SESSION_CHARS } from "./sessions";

const reply: EngineResult = {
  text: "Il vettore descrive il punto [P1].",
  model: "claude-sonnet-5",
  provider: "claude",
  inputTokens: 12,
};

type Seen = {
  prompt: string;
  system?: string;
  conversation?: {
    key: string;
    followUp: string;
    session?: { provider: string; id: string; cwd: string; seen?: boolean } | null;
    onSession?: (sessionId: string, provider: string, cwd: string) => void;
  };
  cache?: boolean;
};

/** An answer of a CLI tool: the session it ran in, and whether it continued the one the chat stored. */
function toolReply(sessionId: string, input: Seen, provider = "claude"): EngineResult {
  const continued = input.conversation?.session?.id === sessionId && input.conversation.session.provider === provider;
  return { ...reply, provider, sessionId, cwd: "/scratch", continued };
}

function setup() {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
  const book = zipSync({
    "smartbook.json": strToU8(
      JSON.stringify({
        id: "vectors",
        title: "Vectors",
        access: "public",
        chapters: [{ id: "c1", number: 1, title: "Vettori", file: "01.md" }],
      }),
    ),
    "chapters/01.md": strToU8(
      "## p1 | Posizione\nIl vettore posizione descrive il punto.\n",
    ),
  });
  const { sourceId } = importSmartbook(db, book);
  return { db, sourceId };
}

describe("a chat turn's prompt", () => {
  it("puts the earlier turns before this question's passages and the question last", async () => {
    const { db, sourceId } = setup();
    const first = await askTurn(db, {
      text: "Che cos'è il vettore posizione?",
      sourceIds: [sourceId],
      run: async () => reply,
    });
    let seen: Seen | undefined;
    await askTurn(db, {
      chatId: first.chatId,
      text: "E il vettore spostamento?",
      run: async (input) => {
        seen = input;
        return reply;
      },
    });
    const prompt = seen!.prompt;
    const history = prompt.indexOf("Earlier turns:");
    const passages = prompt.indexOf("[P1]");
    const question = prompt.lastIndexOf("Question:\nE il vettore spostamento?");
    expect(history).toBeGreaterThanOrEqual(0);
    expect(passages).toBeGreaterThan(history);
    expect(question).toBeGreaterThan(passages);
    db.close();
  });

  it("offers the engine a follow-up with only the new question and its passages, cached", async () => {
    const { db, sourceId } = setup();
    const first = await askTurn(db, {
      text: "Che cos'è il vettore posizione?",
      sourceIds: [sourceId],
      run: async () => reply,
    });
    let seen: Seen | undefined;
    await askTurn(db, {
      chatId: first.chatId,
      text: "E il vettore spostamento?",
      run: async (input) => {
        seen = input;
        return reply;
      },
    });
    expect(seen!.cache).toBe(true);
    expect(seen!.conversation?.key).toBe(first.chatId);
    const followUp = seen!.conversation!.followUp;
    expect(followUp).not.toContain("Earlier turns:");
    expect(followUp).not.toContain("Che cos'è il vettore posizione?");
    expect(followUp).toContain("[P1]");
    expect(followUp).toContain("numbered from P1 again");
    expect(followUp.endsWith("Question:\nE il vettore spostamento?")).toBe(
      true,
    );
    db.close();
  });

});

describe("a chat's stored tool session", () => {
  /** Asks, in a chat on `provider`, and gives back what the engine was sent. */
  async function ask(
    db: ReturnType<typeof setup>["db"],
    text: string,
    options: { chatId?: string; sourceIds?: string[]; sessionId?: string; provider?: string; subject?: string } = {},
  ) {
    let seen!: Seen;
    const result = await askTurn(db, {
      chatId: options.chatId,
      text,
      sourceIds: options.sourceIds,
      subject: options.subject,
      allowGeneral: options.sourceIds === undefined,
      run: async (input) => {
        // The follow-up is read while the engine runs, as the funnel does: it is built for the engine that asks.
        seen = { ...input, conversation: input.conversation && { ...input.conversation, followUp: input.conversation.followUp } } as Seen;
        return toolReply(options.sessionId ?? "s1", seen, options.provider);
      },
    });
    return { seen, chatId: result.chatId, result };
  }

  it("stores the session of the first turn and continues it, so one chat is one session", async () => {
    const { db } = setup();
    const first = await ask(db, "prima");
    expect(first.seen.conversation?.session).toBeNull();
    expect(currentSession(db, first.chatId)).toMatchObject({ provider: "claude", sessionId: "s1", cwd: "/scratch" });
    const second = await ask(db, "seconda", { chatId: first.chatId });
    expect(second.seen.conversation?.session).toEqual({ provider: "claude", id: "s1", cwd: "/scratch", seen: false });
    await ask(db, "terza", { chatId: first.chatId });
    expect(sessionsOpened(db, first.chatId)).toBe(1);
    db.close();
  });

  it("delivers the current instructions to a session opened under another system prompt, on the tool that carries them in the prompt", async () => {
    for (const [provider, model, carries] of [
      ["agent", "cursor-grok-4.5", true],
      // Antigravity takes the system prompt in its session's own slot on every call, so a turn needs nothing more.
      ["antigravity", "gemini-3.8-flash", false],
      ["claude", "claude-sonnet-5", false],
    ] as const) {
      const { db } = setup();
      db.prepare("UPDATE feature_engines SET selection_json = ?").run(JSON.stringify({ provider, model }));
      const first = await ask(db, "prima", { provider, sessionId: "s1" });
      // The template was edited since the session was opened.
      db.prepare("UPDATE tool_sessions SET instructions = 'older' WHERE owner = ?").run(first.chatId);
      const next = await ask(db, "seconda", { chatId: first.chatId, provider, sessionId: "s1" });
      const sent = next.seen.conversation!.followUp;
      expect(sent.startsWith("<instructions>\nYou are Pyxis, a study tutor"), provider).toBe(carries);
      // Every tool gets the full context block again, since the session is out of step.
      expect(sent, provider).toContain("<context>");
      // The session has the current instructions now, so the turn after it sends neither.
      const after = await ask(db, "terza", { chatId: first.chatId, provider, sessionId: "s1" });
      expect(after.seen.conversation!.followUp, provider).not.toContain("<instructions>");
      expect(after.seen.conversation!.followUp, provider).not.toContain("<context>");
      db.close();
    }
  });

  it("counts a turn once when the tool names its session before the turn ends", async () => {
    const { db } = setup();
    const first = await askTurn(db, {
      text: "prima",
      allowGeneral: true,
      run: async (input) => {
        (input as Seen).conversation?.onSession?.("s1", "claude", "/scratch");
        return toolReply("s1", input as Seen);
      },
    });
    await ask(db, "seconda", { chatId: first.chatId });
    expect(db.prepare("SELECT turns FROM tool_sessions WHERE owner = ?").pluck().get(first.chatId)).toBe(2);
    db.close();
  });

  it("keeps the system prompt the same for the whole chat, whatever the question or the context", async () => {
    const { db } = setup();
    db.prepare("INSERT INTO subjects (id, name, created_at) VALUES ('s-fis', 'Fisica', 1)").run();
    const first = await ask(db, "Che cos'è il vettore posizione?");
    const guided = await ask(db, "Non ho capito, guidami passo passo", { chatId: first.chatId });
    const solved = await ask(db, "Dammi la soluzione", { chatId: first.chatId });
    const subject = await ask(db, "Ora parliamo di altro", { chatId: first.chatId, subject: "Fisica" });
    saveProfile(db, { followups: false });
    const followups = await ask(db, "E dopo?", { chatId: first.chatId });
    for (const turn of [guided, solved, subject, followups]) expect(turn.seen.system).toBe(first.seen.system);
    expect(first.seen.system).not.toContain("Italian");
    expect(first.seen.system).not.toContain("Fisica");
    db.close();
  });

  it("sends the context block with a turn only when it differs from the one the session last received", async () => {
    const { db } = setup();
    db.prepare("INSERT INTO subjects (id, name, created_at) VALUES ('s-fis', 'Fisica', 1)").run();
    const first = await ask(db, "Che cos'è il vettore posizione?");
    expect(first.seen.prompt).toContain("<context>");
    const same = await ask(db, "E il vettore spostamento?", { chatId: first.chatId });
    expect(same.seen.conversation!.followUp).not.toContain("<context>");
    // Asking for a hint or for the solution changes nothing in the block: there is one way of answering.
    const hint = await ask(db, "Non ho capito, dammi un indizio", { chatId: first.chatId });
    expect(hint.seen.conversation!.followUp).not.toContain("<context>");
    const subject = await ask(db, "E in meccanica?", { chatId: first.chatId, subject: "Fisica" });
    expect(subject.seen.conversation!.followUp).toContain("Subject: Fisica.");
    const again = await ask(db, "E il resto?", { chatId: first.chatId });
    expect(again.seen.conversation!.followUp).not.toContain("<context>");
    saveProfile(db, { followups: false });
    const off = await ask(db, "E poi?", { chatId: first.chatId });
    expect(off.seen.conversation!.followUp).toContain("Follow-ups: leave the <followups> block out.");
    db.close();
  });

  it("starts a new session, handing the whole conversation across once, only when the turn goes to another tool", async () => {
    const { db } = setup();
    const first = await ask(db, "domanda uno", { provider: "claude" });
    // Past the old limit of eight messages and 6,000 characters.
    const long = "x".repeat(2000);
    let chatId = first.chatId;
    for (let n = 0; n < 12; n += 1) chatId = (await ask(db, `${n} ${long}`, { chatId, provider: "claude" })).chatId;
    const moved = await ask(db, "e adesso?", { chatId, provider: "codex", sessionId: "c1" });
    expect(moved.seen.conversation!.session).toEqual({ provider: "claude", id: "s1", cwd: "/scratch", seen: false });
    // The engine moved: the funnel answers with the whole prompt, which carries every earlier message.
    expect(moved.seen.prompt).toContain("Earlier turns:");
    expect(moved.seen.prompt).toContain("domanda uno");
    expect(moved.seen.prompt).toContain(`11 ${long}`);
    expect(moved.seen.prompt).not.toContain("left out");
    expect(currentSession(db, chatId)).toMatchObject({ provider: "codex", sessionId: "c1" });
    expect(
      db.prepare("SELECT provider, ended_reason FROM tool_sessions WHERE owner = ? ORDER BY opened_at").all(chatId),
    ).toEqual([
      { provider: "claude", ended_reason: "tool" },
      { provider: "codex", ended_reason: null },
    ]);
    expect(sessionsOpened(db, chatId)).toBe(2);
    const next = await ask(db, "ancora", { chatId, provider: "codex", sessionId: "c1" });
    expect(next.seen.conversation!.session?.id).toBe("c1");
    db.close();
  });

  it("opens a new session, with the conversation handed across, when the tool started one because it lost the stored one", async () => {
    const { db } = setup();
    const first = await ask(db, "prima", { provider: "claude" });
    const second = await ask(db, "seconda", { chatId: first.chatId, provider: "claude", sessionId: "s2" });
    expect(second.seen.conversation!.session?.id).toBe("s1");
    expect(currentSession(db, first.chatId)?.sessionId).toBe("s2");
    expect(
      db.prepare("SELECT ended_reason FROM tool_sessions WHERE owner = ? AND ended_at IS NOT NULL").pluck().all(first.chatId),
    ).toEqual(["gone"]);
    db.close();
  });

  it("hands a local model only what its window holds", async () => {
    const { db } = setup();
    const first = await ask(db, "prima");
    let chatId = first.chatId;
    for (let n = 0; n < 8; n += 1) chatId = (await ask(db, `${n} ${"y".repeat(5000)}`, { chatId })).chatId;
    let prompt = "";
    await askTurn(db, {
      chatId,
      text: "ora",
      allowGeneral: true,
      run: async (input) => {
        prompt = input.prompt;
        return reply;
      },
    });
    expect(prompt.length).toBeLessThan(300_000);
    db.close();
  });

  it("lets the session go on after the student stopped a turn, and replays what the student sees", async () => {
    const { db } = setup();
    const first = await ask(db, "prima");
    const controller = new AbortController();
    const stopped = await askTurn(db, {
      chatId: first.chatId,
      text: "Spiegami i vettori",
      allowGeneral: true,
      signal: controller.signal,
      run: async (input) => {
        (input as Seen).conversation?.onSession?.("s1", "claude", "/scratch");
        input.onDelta?.("I vettori sono frecce che");
        controller.abort();
        throw new DOMException("stopped", "AbortError");
      },
    });
    expect(stopped.message?.stopped).toBe(true);
    // The tool still holds the session, with no new one opened.
    expect(sessionsOpened(db, first.chatId)).toBe(1);
    const next = await ask(db, "e le matrici?", { chatId: first.chatId });
    expect(next.seen.conversation!.session?.id).toBe("s1");
    // The session is out of step: it gets the full context block and what the student sees since the last complete turn.
    const replay = next.seen.conversation!.followUp;
    expect(replay).toContain("<context>");
    expect(replay).toContain("This, not anything you remember differently, is the conversation");
    expect(replay).toContain("user: Spiegami i vettori\nassistant (stopped, the student saw only this): I vettori sono frecce che");
    expect(replay.indexOf("stopped, the student saw only this")).toBeLessThan(replay.indexOf("Question:\ne le matrici?"));
    expect(replay).not.toContain("user: prima");
    // The turn completed, so the session is in step again: one turn later nothing is replayed.
    const after = await ask(db, "e i tensori?", { chatId: first.chatId });
    expect(after.seen.conversation!.followUp).not.toContain("not anything you remember differently");
    expect(after.seen.conversation!.followUp).not.toContain("<context>");
    db.close();
  });

  it("stores a session Cursor Agent began in a stopped turn only once a turn ends, since it loses a cut turn", async () => {
    const { db } = setup();
    const controller = new AbortController();
    const stopped = await askTurn(db, {
      text: "Spiegami i vettori",
      allowGeneral: true,
      signal: controller.signal,
      run: async (input) => {
        (input as Seen).conversation?.onSession?.("a1", "agent", "/scratch");
        input.onDelta?.("I vettori");
        controller.abort();
        throw new DOMException("stopped", "AbortError");
      },
    });
    expect(currentSession(db, stopped.chatId)).toBeUndefined();
    const next = await ask(db, "riprova", { chatId: stopped.chatId, provider: "agent", sessionId: "a2" });
    expect(next.seen.conversation!.session).toBeNull();
    expect(next.seen.prompt).toContain("Spiegami i vettori");
    expect(currentSession(db, stopped.chatId)?.sessionId).toBe("a2");
    db.close();
  });

  it("replays a question the engine failed on before any text arrived", async () => {
    const { db } = setup();
    const first = await ask(db, "prima");
    await askTurn(db, {
      chatId: first.chatId,
      text: "Spiegami i vettori",
      allowGeneral: true,
      run: async () => {
        throw new Error("boom");
      },
    }).catch(() => undefined);
    const next = await ask(db, "riprova con altre parole", { chatId: first.chatId });
    expect(next.seen.conversation!.followUp).toContain("user: Spiegami i vettori\n\nQuestion:");
    db.close();
  });

  it("keeps the order of a chat's messages when two turns share a millisecond or the clock steps back", async () => {
    vi.useFakeTimers();
    try {
      const { db } = setup();
      vi.setSystemTime(1_000_000);
      const first = await ask(db, "prima");
      // The failed turn starts in the same millisecond as the answer before it.
      await askTurn(db, {
        chatId: first.chatId,
        text: "Spiegami i vettori",
        allowGeneral: true,
        run: async () => {
          throw new Error("boom");
        },
      }).catch(() => undefined);
      const next = await ask(db, "riprova con altre parole", { chatId: first.chatId });
      expect(next.seen.conversation!.followUp).toContain("user: Spiegami i vettori");
      // The clock steps back one minute: the turn after it still comes last.
      vi.setSystemTime(940_000);
      await ask(db, "dopo lo scatto indietro", { chatId: first.chatId });
      const order = db.prepare("SELECT body FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY created_at, rowid").pluck().all(first.chatId);
      expect(order).toEqual(["prima", "Spiegami i vettori", "riprova con altre parole", "dopo lo scatto indietro"]);
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays the question and the answer the student sees after a regenerate that failed or was stopped", async () => {
    const { db } = setup();
    const first = await ask(db, "domanda");
    await regenerateTurn(db, {
      chatId: first.chatId,
      allowGeneral: true,
      run: async () => {
        throw new Error("boom");
      },
    }).catch(() => undefined);
    const afterFailure = await ask(db, "e poi?", { chatId: first.chatId });
    expect(afterFailure.seen.conversation!.followUp).toContain("user: domanda\nassistant: Il vettore descrive il punto [P1].");
    // The session is in step again: nothing is replayed one turn later.
    const later = await ask(db, "e ancora?", { chatId: first.chatId });
    expect(later.seen.conversation!.followUp).not.toContain("user: domanda");
    const controller = new AbortController();
    await regenerateTurn(db, {
      chatId: first.chatId,
      allowGeneral: true,
      signal: controller.signal,
      run: async (input) => {
        input.onDelta?.("Una nuova risposta a metà");
        controller.abort();
        throw new DOMException("stopped", "AbortError");
      },
    }).catch(() => undefined);
    // The stopped replacement is not kept: the answer the student sees is the one before it.
    expect(db.prepare("SELECT stopped FROM messages WHERE chat_id = ? AND role = 'assistant'").pluck().all(first.chatId)).not.toContain(1);
    const afterStop = await ask(db, "e infine?", { chatId: first.chatId });
    expect(afterStop.seen.conversation!.followUp).toContain("user: e ancora?\nassistant: Il vettore descrive il punto [P1].");
    expect(afterStop.seen.conversation!.followUp).not.toContain("a metà");
    expect(sessionsOpened(db, first.chatId)).toBe(1);
    db.close();
  });

  it("sends the current context block after a stopped regenerate that was sent another", async () => {
    const { db } = setup();
    saveProfile(db, { followups: true });
    const first = await ask(db, "domanda");
    saveProfile(db, { followups: false });
    const controller = new AbortController();
    let regenerated = "";
    // The regenerate carries the block with follow-ups off, then is stopped.
    const stopped = await regenerateTurn(db, {
      chatId: first.chatId,
      allowGeneral: true,
      signal: controller.signal,
      run: async (input) => {
        regenerated = (input as Seen).conversation!.followUp;
        controller.abort();
        throw new DOMException("stopped", "AbortError");
      },
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(stopped).toMatchObject({ name: "AbortError" });
    expect(regenerated).toContain("Follow-ups: leave the <followups> block out.");
    // The profile is back as it was when the session last completed a turn, so the stored hash matches the block.
    saveProfile(db, { followups: true });
    const next = await ask(db, "e poi?", { chatId: first.chatId });
    expect(next.seen.conversation!.followUp).toContain("Follow-ups: end with the <followups> block.");
    db.close();
  });

  it("keeps the replay boundary at the last reply that completed, not at a reply the student saw cut off", async () => {
    const { db } = setup();
    const first = await ask(db, "prima");
    // The second question is stopped: its reply is a cut-off one.
    const controller = new AbortController();
    await askTurn(db, {
      chatId: first.chatId,
      text: "seconda",
      allowGeneral: true,
      signal: controller.signal,
      run: async (input) => {
        input.onDelta?.("risposta a metà");
        controller.abort();
        throw new DOMException("stopped", "AbortError");
      },
    });
    await ask(db, "terza", { chatId: first.chatId });
    // The third is answered again and the new answer is stopped, so the old one stays.
    const again = new AbortController();
    await regenerateTurn(db, {
      chatId: first.chatId,
      allowGeneral: true,
      signal: again.signal,
      run: async () => {
        again.abort();
        throw new DOMException("stopped", "AbortError");
      },
    }).catch(() => undefined);
    const next = await ask(db, "quarta", { chatId: first.chatId });
    // The cut-off reply sits between the boundary and the regenerated question, so it is replayed too.
    expect(next.seen.conversation!.followUp).toContain(
      "user: seconda\nassistant (stopped, the student saw only this): risposta a metà\nuser: terza\nassistant: Il vettore descrive il punto [P1].",
    );
    db.close();
  });

  it("leaves the session out of step when a regenerated reply is stopped while its figures are drawn, and when nothing is stored", async () => {
    const { db } = setup();
    const first = await ask(db, "domanda", { provider: "claude", sessionId: "s1" });
    const controller = new AbortController();
    const withFigure = ["Ecco.", "", "```pyxis-figure", JSON.stringify({ caption: "Un seno.", code: "plt.plot([0, 1])" }), "```"].join("\n");
    const stopped = await regenerateTurn(db, {
      chatId: first.chatId,
      allowGeneral: true,
      signal: controller.signal,
      // The model finishes, and the student stops while the figure is drawn.
      python: async () => {
        controller.abort();
        throw new DOMException("stopped", "AbortError");
      },
      run: async (input) => ({ ...toolReply("s1", input as Seen), text: withFigure }),
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(stopped).toMatchObject({ name: "AbortError" });
    // The replacement was dropped: the answer on screen is the one before it, which the session was told to discard.
    expect(db.prepare("SELECT body FROM messages WHERE chat_id = ? AND role = 'assistant'").pluck().all(first.chatId)).toEqual([
      expect.stringContaining("Il vettore descrive il punto"),
    ]);
    expect(currentSession(db, first.chatId)).toMatchObject({ inStep: false });
    const next = await ask(db, "e poi?", { chatId: first.chatId, provider: "claude", sessionId: "s1" });
    expect(next.seen.conversation!.followUp).toContain("user: domanda\nassistant: Il vettore descrive il punto [P1].");
    // An answer that is not stored (NOT_COVERED) is not certified either.
    const none = await askTurn(db, {
      chatId: first.chatId,
      text: "fuori tema",
      allowGeneral: true,
      run: async (input) => ({ ...toolReply("s1", input as Seen), text: "NOT_COVERED" }),
    });
    expect(none.covered).toBe(false);
    expect(currentSession(db, first.chatId)).toMatchObject({ inStep: false });
    const after = await ask(db, "ancora?", { chatId: first.chatId, provider: "claude", sessionId: "s1" });
    expect(after.seen.conversation!.followUp).toContain("user: fuori tema\n\nQuestion:");
    db.close();
  });

  it("counts a session opened during a stopped turn at the whole prompt it received", async () => {
    const { db } = setup();
    db.prepare("UPDATE feature_engines SET selection_json = ?").run(JSON.stringify({ provider: "antigravity", model: "gemini-3.8-flash" }));
    const first = await ask(db, "prima", { provider: "antigravity", sessionId: "g1" });
    const controller = new AbortController();
    let whole = 0;
    await askTurn(db, {
      chatId: first.chatId,
      text: "seconda",
      allowGeneral: true,
      signal: controller.signal,
      run: async (input) => {
        // The tool lost g1 and started g2, which received the whole prompt.
        (input as Seen).conversation?.onSession?.("g2", "antigravity", "/scratch");
        whole = input.prompt.length;
        input.onDelta?.("parziale");
        controller.abort();
        throw new DOMException("stopped", "AbortError");
      },
    });
    expect(currentSession(db, first.chatId)).toMatchObject({ sessionId: "g2" });
    expect(currentSession(db, first.chatId)!.chars).toBe(whole + "parziale".length);
    db.close();
  });

  it("replays both exchanges after two stops in a row on Cursor Agent, which keeps neither", async () => {
    const { db } = setup();
    db.prepare("UPDATE feature_engines SET selection_json = ?").run(JSON.stringify({ provider: "agent", model: "cursor-grok-4.5" }));
    const first = await ask(db, "prima", { provider: "agent", sessionId: "a1" });
    const stop = async (text: string, partial: string) => {
      const controller = new AbortController();
      await askTurn(db, {
        chatId: first.chatId,
        text,
        allowGeneral: true,
        signal: controller.signal,
        run: async (input) => {
          input.onDelta?.(partial);
          controller.abort();
          throw new DOMException("stopped", "AbortError");
        },
      });
    };
    await stop("Spiegami i vettori", "I vettori sono");
    await stop("E le matrici?", "Le matrici sono");
    const next = await ask(db, "e i tensori?", { chatId: first.chatId, provider: "agent", sessionId: "a1" });
    const replay = next.seen.conversation!.followUp;
    expect(replay).toContain(
      "user: Spiegami i vettori\nassistant (stopped, the student saw only this): I vettori sono\nuser: E le matrici?\nassistant (stopped, the student saw only this): Le matrici sono",
    );
    db.close();
  });

  it("replays the exchange a CLI never completed because an API provider answered in its place", async () => {
    const { db } = setup();
    // The CLI names its session, hits its limit, and an API provider answers the first turn.
    const first = await askTurn(db, {
      text: "prima domanda",
      allowGeneral: true,
      run: async (input) => {
        (input as Seen).conversation?.onSession?.("c1", "claude", "/scratch");
        return { ...reply, provider: "openai-api", model: "gpt-5.6-terra", text: "Risposta dell'API." };
      },
    });
    expect(currentSession(db, first.chatId)).toMatchObject({ provider: "claude", sessionId: "c1", inStep: false });
    const back = await ask(db, "seconda domanda", { chatId: first.chatId, provider: "claude", sessionId: "c1" });
    expect(back.seen.conversation!.session?.id).toBe("c1");
    expect(back.seen.conversation!.followUp).toContain("user: prima domanda\nassistant: Risposta dell'API.");
    expect(sessionsOpened(db, first.chatId)).toBe(1);
    expect(currentSession(db, first.chatId)).toMatchObject({ inStep: true });
    db.close();
  });

  it("replays the reply being regenerated when the tool lost its session, the new one started and the student stopped it", async () => {
    const { db } = setup();
    const first = await ask(db, "domanda", { provider: "claude", sessionId: "s1" });
    const controller = new AbortController();
    await regenerateTurn(db, {
      chatId: first.chatId,
      allowGeneral: true,
      signal: controller.signal,
      run: async (input) => {
        // The tool no longer held s1: it started s2, whose first prompt left out the reply being replaced.
        (input as Seen).conversation?.onSession?.("s2", "claude", "/scratch");
        input.onDelta?.("Una nuova risposta a metà");
        controller.abort();
        throw new DOMException("stopped", "AbortError");
      },
    }).catch(() => undefined);
    expect(currentSession(db, first.chatId)).toMatchObject({ sessionId: "s2", inStep: false });
    const next = await ask(db, "e poi?", { chatId: first.chatId, provider: "claude", sessionId: "s2" });
    expect(next.seen.conversation!.followUp).toContain("user: domanda\nassistant: Il vettore descrive il punto [P1].");
    db.close();
  });

  it("counts what a tool keeps of a stopped or failed turn, so the size bound sees it", async () => {
    const { db } = setup();
    const pin = (provider: string, model: string) =>
      db.prepare("UPDATE feature_engines SET selection_json = ?").run(JSON.stringify({ provider, model }));
    pin("antigravity", "gemini-3.8-flash");
    const first = await ask(db, "prima", { provider: "antigravity", sessionId: "g1" });
    const chars = () => currentSession(db, first.chatId)!.chars;
    const before = chars();
    const controller = new AbortController();
    let sent = 0;
    await askTurn(db, {
      chatId: first.chatId,
      text: "Spiegami i vettori",
      allowGeneral: true,
      signal: controller.signal,
      run: async (input) => {
        sent = (input as Seen).conversation!.followUp.length;
        input.onDelta?.("I vettori sono frecce che");
        controller.abort();
        throw new DOMException("stopped", "AbortError");
      },
    });
    // Antigravity keeps the question and the start of the reply; Claude Code and Codex the question; Cursor nothing.
    expect(chars() - before).toBe(sent + "I vettori sono frecce che".length);
    pin("claude", "claude-sonnet-5");
    const claude = await ask(db, "prima", { provider: "claude", sessionId: "c1" });
    const claudeBefore = currentSession(db, claude.chatId)!.chars;
    await askTurn(db, {
      chatId: claude.chatId,
      text: "Spiegami",
      allowGeneral: true,
      run: async (input) => {
        sent = (input as Seen).conversation!.followUp.length;
        throw new Error("boom");
      },
    }).catch(() => undefined);
    expect(currentSession(db, claude.chatId)!.chars - claudeBefore).toBe(sent);
    db.close();
  });

  it("bounds the earlier conversation by the window of the engine that answers", async () => {
    const { db } = setup();
    db.prepare("UPDATE feature_engines SET selection_json = ?").run(JSON.stringify({ provider: "ollama", model: "gemma3:12b" }));
    let chatId: string | undefined;
    for (let n = 0; n < 6; n += 1)
      chatId = (await askTurn(db, { chatId, text: `${n} ${"y".repeat(4000)}`, allowGeneral: true, run: async () => reply })).chatId;
    let prompt = "";
    await askTurn(db, { chatId, text: "ora", allowGeneral: true, run: async (input) => ((prompt = input.prompt), reply) });
    // A local model has a 16,384-token window, about 50,000 characters, and the system prompt and passages need room.
    expect(prompt.length).toBeLessThan(16_000);
    db.close();
  });

  it("goes on in the same session when a reply is regenerated or continued, and tells the model it was asked again", async () => {
    const { db } = setup();
    const first = await ask(db, "domanda");
    let seen!: Seen;
    await regenerateTurn(db, {
      chatId: first.chatId,
      allowGeneral: true,
      run: async (input) => {
        seen = input as Seen;
        return toolReply("s1", seen);
      },
    });
    expect(seen.conversation!.session?.id).toBe("s1");
    expect(seen.conversation!.followUp).toContain("asked for this question to be answered again");
    expect(sessionsOpened(db, first.chatId)).toBe(1);
    db.close();
  });

  it("starts Cursor Agent over, with the conversation handed across, once a session passes the size it is known to handle", async () => {
    const { db } = setup();
    const first = await ask(db, "prima", { provider: "agent", sessionId: "a1" });
    db.prepare("UPDATE tool_sessions SET chars = ? WHERE owner = ?").run(UNCOMPACTED_SESSION_CHARS, first.chatId);
    const next = await ask(db, "dopo", { chatId: first.chatId, provider: "agent", sessionId: "a2" });
    expect(next.seen.conversation!.session).toBeNull();
    expect(next.seen.prompt).toContain("prima");
    expect(
      db.prepare("SELECT ended_reason FROM tool_sessions WHERE owner = ? AND ended_at IS NOT NULL").pluck().all(first.chatId),
    ).toEqual(["long"]);
    // Claude Code, Codex and Antigravity compact a long session themselves, so theirs is never cut.
    for (const provider of ["claude", "antigravity"]) {
      const chat = await ask(db, "prima", { provider, sessionId: "s1" });
      db.prepare("UPDATE tool_sessions SET chars = ? WHERE owner = ?").run(UNCOMPACTED_SESSION_CHARS * 5, chat.chatId);
      const more = await ask(db, "dopo", { chatId: chat.chatId, provider, sessionId: "s1" });
      expect(more.seen.conversation!.session?.id, provider).toBe("s1");
    }
    db.close();
  });

  it("keeps the session of a chat whose pinned context was cleared, and says so in the next context block", async () => {
    const { db } = setup();
    const first = await ask(db, "prima");
    db.prepare("UPDATE chats SET context_json = ? WHERE id = ?").run(
      JSON.stringify({ kind: "passage", title: "Citazione", body: "Testo scelto" }),
      first.chatId,
    );
    const pinned = await ask(db, "con il contesto", { chatId: first.chatId });
    expect(pinned.seen.conversation!.followUp).toContain("Testo scelto");
    clearChatContext(db, first.chatId);
    const cleared = await ask(db, "senza", { chatId: first.chatId });
    expect(cleared.seen.conversation!.followUp).toContain("Pinned context: none.");
    expect(cleared.seen.conversation!.followUp).not.toContain("Testo scelto");
    expect(sessionsOpened(db, first.chatId)).toBe(1);
    db.close();
  });
});

describe("a decision taken from the tool that answers, not the one that was planned", () => {
  const ready = () =>
    rememberReady([
      { id: "claude", kind: "cli", effort: true, models: [{ id: "claude-haiku-5-5", efforts: [] }] },
      { id: "agent", kind: "cli", effort: true, models: [{ id: "cursor-grok-4.5", efforts: [] }] },
    ]);
  const automatic = (db: ReturnType<typeof setup>["db"], provider: string, model: string) =>
    db
      .prepare("UPDATE feature_engines SET selection_json = ?")
      .run(JSON.stringify({ provider, model, auto: true }));

  it("delivers the new instructions to a Cursor session that a fallback resumes, and records the model that answered", async () => {
    const { db } = setup();
    db.prepare("UPDATE feature_engines SET feature = 'chat', selection_json = ?").run(JSON.stringify({ provider: "agent", model: "cursor-grok-4.5" }));
    const first = await askTurn(db, {
      text: "prima",
      allowGeneral: true,
      run: async (input) => toolReply("a1", input as Seen, "agent"),
    });
    db.prepare("UPDATE tool_sessions SET instructions = 'older' WHERE owner = ?").run(first.chatId);
    // The chat's tool is Claude now and is out of requests, so the turn falls back to the Cursor session.
    automatic(db, "claude", "claude-haiku-5-5");
    ready();
    const providers: string[] = [];
    let followUp = "";
    try {
      await askTurn(db, {
        chatId: first.chatId,
        text: "seconda",
        allowGeneral: true,
        run: async (input) => {
          providers.push(input.selection.provider);
          if (input.selection.provider === "claude")
            throw Object.assign(new Error("usage limit"), { code: "cli-failed", limit: { kind: "rate", detail: "usage limit" } });
          followUp = (input as Seen).conversation!.followUp;
          return { ...toolReply("a1", input as Seen, "agent"), model: "cursor-grok-4.5" };
        },
      });
    } finally {
      rememberReady([]);
      clearBench();
    }
    expect(providers).toEqual(["claude", "agent"]);
    expect(followUp.startsWith("<instructions>\nYou are Pyxis, a study tutor")).toBe(true);
    expect(currentSession(db, first.chatId)).toMatchObject({ provider: "agent", sessionId: "a1", inStep: true });
    expect(db.prepare("SELECT model FROM tool_sessions WHERE owner = ? AND ended_at IS NULL").pluck().get(first.chatId)).toBe("cursor-grok-4.5");
    db.close();
  });

  it("runs the separate maths check on the tool that would answer it when Cursor, the chat's tool, is out of requests", async () => {
    const { db } = setup();
    automatic(db, "agent", "cursor-grok-4.5");
    db.prepare("UPDATE feature_engines SET feature = 'chat'").run();
    ready();
    benchEngine("agent", "limit", { retryAfterMs: 60_000 });
    const claim = { kind: "derivative", expr: "x**2", claimed: "2*x", vars: ["x"], step: "La derivata è $f'(x) = 2x$." };
    const providers: string[] = [];
    try {
      const result = await askTurn(db, {
        text: "Deriva x^2",
        allowGeneral: true,
        run: async (input) => {
          providers.push(`${input.selection.provider}${input.responseSchema ? " (check)" : ""}`);
          if (input.responseSchema)
            return { ...reply, provider: "claude", text: JSON.stringify({ checks: [claim] }), structured: { checks: [claim] } };
          return { ...reply, provider: "claude", model: "claude-haiku-5-5", text: claim.step };
        },
      });
      expect(result.message?.checking).toBe(true);
      await settleChecks();
    } finally {
      rememberReady([]);
      clearBench();
    }
    // Cursor was out of requests, so Claude answered the turn and runs the check.
    expect(providers).toEqual(["claude", "claude (check)"]);
    db.close();
  });
});

describe("a stopped reply after the engine switched", () => {
  it("records the engine that answered", async () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('chat', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5", auto: true }));
    rememberReady([
      { id: "claude", kind: "cli", effort: true, models: [{ id: "claude-sonnet-5", efforts: [] }] },
      { id: "codex", kind: "cli", effort: true, models: [{ id: "gpt-5.6-terra", efforts: [] }] },
    ]);
    const controller = new AbortController();
    try {
      const result = await askTurn(db, {
        text: "domanda",
        allowGeneral: true,
        signal: controller.signal,
        run: async (input) => {
          if (input.selection.provider === "claude")
            throw Object.assign(new Error("usage limit"), {
              code: "cli-failed",
              limit: { kind: "rate", detail: "usage limit" },
            });
          input.onDelta?.("Una risposta a metà");
          controller.abort();
          throw new DOMException("stopped", "AbortError");
        },
      });
      expect(result.message).toMatchObject({
        stopped: true,
        provider: "codex",
        modelId: "gpt-5.6-terra",
      });
      expect(readChat(db, result.chatId).at(-1)).toMatchObject({
        provider: "codex",
        modelId: "gpt-5.6-terra",
      });
    } finally {
      rememberReady([]);
      clearBench();
      db.close();
    }
  });
});
