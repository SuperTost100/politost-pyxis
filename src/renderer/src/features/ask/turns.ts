import { latestEvery, liveValue } from "./throttle";

/** A passage the reply being written may cite, with the label its stored message will show. */
export type TurnPassage = { index: number; label: string };

/**
 * A reply being written. It lives outside the Ask page, so a student who opens another page while it streams and comes
 * back finds it still running, with Stop, instead of an idle composer that would send a second question into it.
 */
export type Turn = {
  /** The chat it was sent from: "" for a new chat. */
  readonly from: string;
  /** The chat it runs in: `from`, or for a new chat the one core created for it, once core names it. */
  readonly chat: ReturnType<typeof liveValue<string>>;
  /** The question shown until the stored one arrives; null when the last question is answered again. */
  readonly question: string | null;
  readonly regenerating: boolean;
  /** The chat's last stored message when the question was sent, so the stored question is told from an older one. */
  readonly after: string | null;
  /** The stored message core says is this turn's question, once it has stored it (a new one, or an unanswered one reused). */
  readonly questionId: ReturnType<typeof liveValue<string | null>>;
  /** The reply so far. */
  readonly live: ReturnType<typeof liveValue<string>>;
  /** The passages core retrieved for this turn. Only these become citation chips while the reply streams. */
  readonly passages: ReturnType<typeof liveValue<TurnPassage[]>>;
  /** Takes a stream event: the reply so far, applied at most every 100 ms, or the turn's passages. */
  readonly onEvent: (event: unknown) => void;
  stop: () => void;
  /** The chat was deleted while the reply was written: the turn ends quietly, without putting the message back. */
  dropped: boolean;
  /** Drops reply text not yet applied. */
  readonly cancel: () => void;
};

let active: Turn | null = null;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

/** The one turn the Ask page runs at a time, shared by every mount of the page. */
export const turns = {
  get: (): Turn | null => active,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Starts a turn, or returns null while another one is still running. */
  start(
    from: string,
    question: string | null,
    regenerating = false,
    after: string | null = null,
  ): Turn | null {
    if (active) return null;
    const live = liveValue("");
    const passages = liveValue<TurnPassage[]>([]);
    const questionId = liveValue<string | null>(null);
    const chat = liveValue(from);
    // Each delta carries the whole reply so far. Rendering it at most every 100 ms keeps long answers with math responsive.
    const text = latestEvery<string>(100, live.set);
    const turn: Turn = {
      from,
      chat,
      question,
      regenerating,
      after,
      live,
      passages,
      onEvent(event) {
        const data = event as { type?: string; text?: unknown; passages?: unknown; id?: unknown; chatId?: unknown };
        if (typeof data.text === "string") text.push(data.text);
        else if (data.type === "question" && typeof data.id === "string") {
          questionId.set(data.id);
          if (typeof data.chatId === "string") chat.set(data.chatId);
        }
        else if (data.type === "passages" && Array.isArray(data.passages))
          passages.set(data.passages as TurnPassage[]);
      },
      questionId,
      stop: () => undefined,
      dropped: false,
      cancel: text.cancel,
    };
    active = turn;
    changed();
    return turn;
  },
  end(turn: Turn) {
    turn.cancel();
    if (active !== turn) return;
    active = null;
    changed();
  },
};

/**
 * Whether the chat as read holds the turn's question. Core stores it before the reply streams, so a chat read again
 * mid-reply, after coming back to Ask, already shows it and the pending copy would show it twice.
 */
export function questionStored(
  turn: Turn,
  last: { id: string; role: string; body: string } | undefined,
): boolean {
  return last?.role === "user" && (last.id !== turn.after || last.id === turn.questionId.get());
}

/** Whether the page for `chatId` ("" for a new chat) shows the turn: the chat it was sent from, or the one it created. */
export function runsIn(turn: Turn, chatId: string): boolean {
  return turn.from === chatId || turn.chat.get() === chatId;
}
