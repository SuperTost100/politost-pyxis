import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { questionStored, turns } from "./turns";

describe("the Ask page's turn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    const turn = turns.get();
    if (turn) turns.end(turn);
    vi.useRealTimers();
  });

  it("runs one at a time and tells its subscribers when it starts and ends", () => {
    const seen: Array<string | null> = [];
    const off = turns.subscribe(() => seen.push(turns.get()?.from ?? null));
    const turn = turns.start("chat-1", "Domanda")!;
    expect(turns.start("chat-2", "Altra")).toBeNull();
    expect(turns.get()).toBe(turn);
    turns.end(turn);
    turns.end(turn);
    off();
    expect(seen).toEqual(["chat-1", null]);
    expect(turns.get()).toBeNull();
  });

  it("takes the reply text and the turn's passages from stream events", () => {
    const turn = turns.start("", "Domanda")!;
    turn.onEvent({ type: "passages", passages: [{ index: 1, label: "Vettori" }] });
    turn.onEvent({ type: "text", text: "Il vettore" });
    vi.advanceTimersByTime(0);
    expect(turn.passages.get()).toEqual([{ index: 1, label: "Vettori" }]);
    expect(turn.live.get()).toBe("Il vettore");
    // Text not yet applied when the turn ends is dropped.
    turn.onEvent({ type: "text", text: "Il vettore posizione" });
    turns.end(turn);
    vi.advanceTimersByTime(200);
    expect(turn.live.get()).toBe("Il vettore");
  });

  it("knows when the chat as read already holds the question being answered", () => {
    const older = { id: "m1", role: "user", body: "Prima domanda" };
    const turn = turns.start("chat-1", "Seconda domanda", false, "m1")!;
    // Read before core stored it: only the earlier, unanswered question.
    expect(questionStored(turn, older)).toBe(false);
    expect(questionStored(turn, { id: "m0", role: "assistant", body: "Risposta" })).toBe(false);
    expect(questionStored(turn, undefined)).toBe(false);
    // Read again mid-reply.
    expect(questionStored(turn, { id: "m2", role: "user", body: "Seconda domanda" })).toBe(true);
    turns.end(turn);
    // The same question sent again reuses the unanswered message, which core names once it has stored the turn. Only
    // then is it this turn's question: a matching text alone may still get a row of its own, with attachment notes.
    const again = turns.start("chat-1", "Prima domanda", false, "m1")!;
    expect(questionStored(again, older)).toBe(false);
    // The page subscribes to the name, so the pending copy goes as soon as core gives it, not when the reply ends.
    const named = vi.fn();
    again.questionId.subscribe(named);
    again.onEvent({ type: "question", id: "m1" });
    expect(named).toHaveBeenCalledOnce();
    expect(questionStored(again, older)).toBe(true);
  });
});
