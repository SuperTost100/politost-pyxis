import type Database from "better-sqlite3";
import { askTurn, chatContext, chatPickedSources, chatPlan, chatSubject, clearChatContext, deleteChat, heldSources, listChats, rateMessage, readChat, regenerateTurn, renameChat, seedChat } from "./turn";

/** Recorded reply for tests. With a delay it waits, then streams the words, so the thinking and streaming states can be seen. */
function recordedReply(text: string, delayMs: number) {
  return async (input: { signal?: AbortSignal; onDelta?: (text: string) => void }) => {
    if (delayMs > 0) {
      const pause = (ms: number) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          input.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      await pause(delayMs / 2);
      const words = text.split(/(?<=\s)/);
      const step = Math.max(1, Math.ceil(words.length / 20));
      for (let at = step; at < words.length + step; at += step) {
        input.onDelta?.(words.slice(0, at).join(""));
        await pause(delayMs / 2 / Math.ceil(words.length / step));
      }
    }
    return { text, model: "fixture", provider: "fixture", inputTokens: 0 };
  };
}

export function chatHandlers(db: Database.Database, workspace = "", fixtureReply?: string, replyDelayMs = 0) {
  return {
    list() {
      return listChats(db).map((row) => ({
        id: row.id,
        title: row.title,
        updatedAt: row.updated_at,
      }));
    },
    read(input: { chatId: string }) {
      return {
        sourceIds: chatPickedSources(db, input.chatId),
        planId: chatPlan(db, input.chatId),
        subject: chatSubject(db, input.chatId),
        context: chatContext(db, input.chatId),
        held: heldSources(db, input.chatId),
        messages: readChat(db, input.chatId),
      };
    },
    seed(input: {
      planId?: string;
      kind: "answer" | "passage";
      title: string;
      body: string;
      sourceIds?: string[];
      subject?: string;
    }) {
      return seedChat(db, input);
    },
    clearContext(input: { chatId: string }) {
      clearChatContext(db, input.chatId);
      return { ok: true as const };
    },
    rate(input: { messageId: string; reaction: "up" | "down" }) {
      return { reaction: rateMessage(db, input.messageId, input.reaction) };
    },
    rename(input: { chatId: string; title: string }) {
      renameChat(db, input.chatId, input.title);
      return { ok: true as const };
    },
    remove(input: { chatId: string }) {
      deleteChat(db, workspace, input.chatId);
      return { ok: true as const };
    },
    regenerate(input: {
      chatId: string;
      sourceIds?: string[];
      planId?: string | null;
      mode?: "solver" | "socratic";
      allowGeneral?: boolean;
      signal?: AbortSignal;
      onDelta?: (text: string) => void;
      subject?: string;
      files?: string[];
    }) {
      return regenerateTurn(db, {
        ...input,
        workspace,
        run: fixtureReply ? recordedReply(fixtureReply, replyDelayMs) : undefined,
      });
    },
    ask(input: {
      chatId?: string;
      text: string;
      sourceIds?: string[];
      planId?: string | null;
      mode?: "solver" | "socratic";
      allowGeneral?: boolean;
      signal?: AbortSignal;
      onDelta?: (text: string) => void;
      subject?: string;
      files?: string[];
    }) {
      return askTurn(db, {
        ...input,
        workspace,
        run: fixtureReply ? recordedReply(fixtureReply, replyDelayMs) : undefined,
      });
    },
  };
}
