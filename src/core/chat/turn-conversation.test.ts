import { describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { openDatabase } from "../db/connection";
import type { EngineResult } from "../engine/funnel";
import { importSmartbook } from "../sources/smartbook";
import { clearBench } from "../engine/bench";
import { rememberReady } from "../engine/selection";
import { askTurn, clearChatContext, readChat, regenerateTurn } from "./turn";
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
    session?: { provider: string; id: string; cwd: string };
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
    options: { chatId?: string; sourceIds?: string[]; sessionId?: string; provider?: string; subject?: string; way?: "solved" | "guided" } = {},
  ) {
    let seen!: Seen;
    const result = await askTurn(db, {
      chatId: options.chatId,
      text,
      sourceIds: options.sourceIds,
      subject: options.subject,
      way: options.way,
      allowGeneral: options.sourceIds === undefined,
      run: async (input) => {
        seen = input as Seen;
        return toolReply(options.sessionId ?? "s1", seen, options.provider);
      },
    });
    return { seen, chatId: result.chatId, result };
  }

  it("stores the session of the first turn and continues it, so one chat is one session", async () => {
    const { db } = setup();
    const first = await ask(db, "prima");
    expect(first.seen.conversation?.session).toBeUndefined();
    expect(currentSession(db, first.chatId)).toMatchObject({ provider: "claude", sessionId: "s1", cwd: "/scratch" });
    const second = await ask(db, "seconda", { chatId: first.chatId });
    expect(second.seen.conversation?.session).toEqual({ provider: "claude", id: "s1", cwd: "/scratch" });
    await ask(db, "terza", { chatId: first.chatId });
    expect(sessionsOpened(db, first.chatId)).toBe(1);
    db.close();
  });

  it("keeps the system prompt the same for the whole chat, whatever way the reply takes", async () => {
    const { db } = setup();
    const first = await ask(db, "Che cos'è il vettore posizione?");
    const guided = await ask(db, "Non ho capito, guidami passo passo", { chatId: first.chatId });
    const solved = await ask(db, "Dammi la soluzione", { chatId: first.chatId });
    const subject = await ask(db, "Ora parliamo di altro", { chatId: first.chatId, subject: "Fisica" });
    expect(guided.seen.system).toBe(first.seen.system);
    expect(solved.seen.system).toBe(first.seen.system);
    expect(subject.seen.system).toBe(first.seen.system);
    expect(first.seen.system).not.toContain("Italian");
    db.close();
  });

  it("sends the context block with a turn only when it differs from the one the session last received", async () => {
    const { db } = setup();
    db.prepare("INSERT INTO subjects (id, name, created_at) VALUES ('s-fis', 'Fisica', 1)").run();
    const first = await ask(db, "Che cos'è il vettore posizione?");
    expect(first.seen.prompt).toContain("<context>");
    const same = await ask(db, "E il vettore spostamento?", { chatId: first.chatId });
    expect(same.seen.conversation!.followUp).not.toContain("<context>");
    const guided = await ask(db, "Non ho capito, guidami passo passo", { chatId: first.chatId });
    expect(guided.seen.conversation!.followUp).toContain("<context>");
    expect(guided.seen.conversation!.followUp).toContain("Guide the student one step at a time.");
    const subject = await ask(db, "E in meccanica?", { chatId: first.chatId, subject: "Fisica", way: "guided" });
    expect(subject.seen.conversation!.followUp).toContain("Subject: Fisica.");
    const again = await ask(db, "E il resto?", { chatId: first.chatId, way: "guided" });
    expect(again.seen.conversation!.followUp).not.toContain("<context>");
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
    expect(moved.seen.conversation!.session).toEqual({ provider: "claude", id: "s1", cwd: "/scratch" });
    // The engine moved: the funnel answers with the whole prompt, which carries every earlier message.
    expect(moved.seen.prompt).toContain("Earlier turns:");
    expect(moved.seen.prompt).toContain("domanda uno");
    expect(moved.seen.prompt).toContain(`11 ${long}`);
    expect(moved.seen.prompt).not.toContain("left out");
    expect(currentSession(db, chatId)).toMatchObject({ provider: "codex", sessionId: "c1" });
    expect(
      db.prepare("SELECT provider, ended_reason FROM chat_sessions WHERE chat_id = ? ORDER BY opened_at").all(chatId),
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
      db.prepare("SELECT ended_reason FROM chat_sessions WHERE chat_id = ? AND ended_at IS NOT NULL").pluck().all(first.chatId),
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

  it("lets the session go on after the student stopped a turn, and says what the student saw of it", async () => {
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
    const note = next.seen.conversation!.followUp;
    expect(note).toContain('cut off before its end, to the question "Spiegami i vettori"');
    expect(note).toContain("I vettori sono frecce che");
    expect(note.indexOf("cut off")).toBeLessThan(note.indexOf("Question:\ne le matrici?"));
    // One turn later the notice is gone.
    const after = await ask(db, "e i tensori?", { chatId: first.chatId });
    expect(after.seen.conversation!.followUp).not.toContain("cut off");
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
    expect(next.seen.conversation!.session).toBeUndefined();
    expect(next.seen.prompt).toContain("Spiegami i vettori");
    expect(currentSession(db, stopped.chatId)?.sessionId).toBe("a2");
    db.close();
  });

  it("names a question the engine failed on before any text arrived", async () => {
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
    expect(next.seen.conversation!.followUp).toContain('Your answer to the student\'s earlier question "Spiegami i vettori" failed before any text arrived');
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
      expect(next.seen.conversation!.followUp).toContain('failed before any text arrived');
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

  it("tells the session what the student sees when a regenerated reply failed or was stopped", async () => {
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
    expect(afterFailure.seen.conversation!.followUp).toContain("The student still sees your earlier answer");
    // The notice is told once.
    const later = await ask(db, "e ancora?", { chatId: first.chatId });
    expect(later.seen.conversation!.followUp).not.toContain("still sees your earlier answer");
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
    expect(afterStop.seen.conversation!.followUp).toContain("The student still sees your earlier answer");
    expect(sessionsOpened(db, first.chatId)).toBe(1);
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

  it("starts Cursor Agent and Antigravity over, with the conversation handed across, once a session passes the size they are known to handle", async () => {
    const { db } = setup();
    const first = await ask(db, "prima", { provider: "agent", sessionId: "a1" });
    db.prepare("UPDATE chat_sessions SET chars = ? WHERE chat_id = ?").run(UNCOMPACTED_SESSION_CHARS, first.chatId);
    const next = await ask(db, "dopo", { chatId: first.chatId, provider: "agent", sessionId: "a2" });
    expect(next.seen.conversation!.session).toBeUndefined();
    expect(next.seen.prompt).toContain("prima");
    expect(
      db.prepare("SELECT ended_reason FROM chat_sessions WHERE chat_id = ? AND ended_at IS NOT NULL").pluck().all(first.chatId),
    ).toEqual(["long"]);
    // Claude Code and Codex compact a long session themselves, so theirs is never cut.
    const claude = await ask(db, "prima", { provider: "claude", sessionId: "s1" });
    db.prepare("UPDATE chat_sessions SET chars = ? WHERE chat_id = ?").run(UNCOMPACTED_SESSION_CHARS * 5, claude.chatId);
    const more = await ask(db, "dopo", { chatId: claude.chatId, provider: "claude", sessionId: "s1" });
    expect(more.seen.conversation!.session?.id).toBe("s1");
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
