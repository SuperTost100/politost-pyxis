import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { questionStored, runsIn, turns } from "./turns";

describe("the Ask page's turn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    const turn = turns.get();
    if (turn) turns.end(turn);
    vi.useRealTimers();
  });

  it("keeps each figure of the reply as it is told, a picture or an empty one for a figure left out, apart from the text", () => {
    const turn = turns.start("chat-1", "Domanda")!;
    expect(turn.figures.get()).toEqual({});
    const seen: Array<Record<string, string>> = [];
    turn.figures.subscribe(() => seen.push(turn.figures.get()));
    turn.onEvent({ type: "figure", key: "figure-a", image: "data:image/png;base64,AAAA" });
    turn.onEvent({ type: "text", text: "Il testo continua." });
    turn.onEvent({ type: "figure", key: "figure-b", image: null });
    expect(turn.figures.get()).toEqual({ "figure-a": "data:image/png;base64,AAAA", "figure-b": "" });
    // Each told figure is a change of its own, and the earlier ones stay as they were.
    expect(seen).toEqual([{ "figure-a": "data:image/png;base64,AAAA" }, { "figure-a": "data:image/png;base64,AAAA", "figure-b": "" }]);
    // The next turn starts with none.
    turns.end(turn);
    expect(turns.start("chat-1", "Altra")!.figures.get()).toEqual({});
  });

  it("keeps a figure's dark picture under its dark key, beside the picture", () => {
    const turn = turns.start("chat-1", "Domanda")!;
    turn.onEvent({ type: "figure", key: "figure-a", image: "data:image/png;base64,AAAA", dark: "data:image/png;base64,BBBB" });
    turn.onEvent({ type: "figure", key: "figure-b", image: "data:image/png;base64,CCCC" });
    expect(turn.figures.get()).toEqual({
      "figure-a": "data:image/png;base64,AAAA",
      "figure-a-dark": "data:image/png;base64,BBBB",
      "figure-b": "data:image/png;base64,CCCC",
    });
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

  it("runs in the chat core created for a first question, once core names it", () => {
    const turn = turns.start("", "Prima domanda")!;
    expect(runsIn(turn, "")).toBe(true);
    expect(runsIn(turn, "chat-new")).toBe(false);
    const moved = vi.fn();
    turn.chat.subscribe(moved);
    turn.onEvent({ type: "question", id: "m1", chatId: "chat-new" });
    expect(moved).toHaveBeenCalledOnce();
    expect(runsIn(turn, "chat-new")).toBe(true);
    expect(runsIn(turn, "")).toBe(true);
    expect(runsIn(turn, "chat-other")).toBe(false);
  });
});
