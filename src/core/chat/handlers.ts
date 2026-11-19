import type Database from "better-sqlite3";
import { endConversation } from "../engine/funnel";
import { isFigureFixCall, recordedPlanRun } from "../engine/recorded-plan";
import { exportChat, type ChatExportLanguage } from "./export";
import { searchChats } from "./search";
import { chatUsage } from "../engine/usage";
import { sessionsOpened } from "./sessions";
import type { FigureEvent } from "../math/figures";
import { askTurn, chatContext, chatPickedSources, chatPlan, chatSubject, chatSubjectBy, clearChatContext, deleteChat, heldSources, listChats, rateMessage, readChat, regenerateTurn, renameChat, seedChat, setChatSubject } from "./turn";

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
    // Rough counts, so the token figures have something to show in end-to-end runs.
    return {
      text,
      model: "fixture",
      provider: "fixture",
      inputTokens: 1200,
      outputTokens: Math.ceil(text.length / 4),
      cacheReadTokens: 800,
    };
  };
}

/**
 * The recorded run of a chat turn: the recorded reply for the tutor, and the recorded `figureFix` replies of the plan
 * fixture, when there is one, for the call that corrects a figure.
 */
function recordedChat(text: string, delayMs: number, figureFixes?: string) {
  const reply = recordedReply(text, delayMs);
  const fixes = figureFixes ? recordedPlanRun(figureFixes) : undefined;
  return ((input: Parameters<typeof reply>[0] & { system?: string }) =>
    fixes && isFigureFixCall(input.system) ? fixes(input as never) : reply(input)) as unknown as typeof reply;
}

export function chatHandlers(db: Database.Database, workspace = "", fixtureReply?: string, replyDelayMs = 0, figureFixes?: string) {
  return {
    list() {
      return listChats(db).map((row) => ({
        id: row.id,
        title: row.title,
        subject: row.subject,
        updatedAt: row.updated_at,
      }));
    },
    read(input: { chatId: string }) {
      return {
        sourceIds: chatPickedSources(db, input.chatId),
        planId: chatPlan(db, input.chatId),
        subject: chatSubject(db, input.chatId),
        subjectBy: chatSubjectBy(db, input.chatId),
        context: chatContext(db, input.chatId),
        held: heldSources(db, input.chatId),
        usage: chatUsage(db, input.chatId),
        sessions: sessionsOpened(db, input.chatId),
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
    setSubject(input: { chatId: string; subject: string | null }) {
      setChatSubject(db, input.chatId, input.subject);
      return { ok: true as const };
    },
    clearContext(input: { chatId: string }) {
      // The next message's context block says there is none, so the tool's session goes on.
      clearChatContext(db, input.chatId);
      return { ok: true as const };
    },
    /** The student left the chat: its engine conversation, and a live CLI process with it, can stop. */
    leave(input: { chatId: string }) {
      endConversation(input.chatId);
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
      endConversation(input.chatId);
      deleteChat(db, workspace, input.chatId);
      return { ok: true as const };
    },
    search(input: { query: string; subject?: string }) {
      return searchChats(db, input.query, input.subject);
    },
    exportChat(input: { chatId: string; language: ChatExportLanguage }) {
      return exportChat(db, input.chatId, input.language);
    },
    regenerate(input: {
      chatId: string;
      engine?: "chat" | "strong";
      resume?: boolean;
      allowGeneral?: boolean;
      signal?: AbortSignal;
      onDelta?: (text: string) => void;
      onFigure?: (event: FigureEvent) => void;
      onPassages?: (passages: Array<{ index: number; label: string }>) => void;
      files?: string[];
    }) {
      return regenerateTurn(db, {
        ...input,
        workspace,
        run: fixtureReply ? recordedChat(fixtureReply, replyDelayMs, figureFixes) : undefined,
      });
    },
    ask(input: {
      chatId?: string;
      text: string;
      sourceIds?: string[];
      planId?: string | null;
      allowGeneral?: boolean;
      signal?: AbortSignal;
      onDelta?: (text: string) => void;
      onFigure?: (event: FigureEvent) => void;
      onPassages?: (passages: Array<{ index: number; label: string }>) => void;
      onQuestion?: (messageId: string, chatId: string) => void;
      subject?: string | null;
      files?: string[];
    }) {
      return askTurn(db, {
        ...input,
        workspace,
        run: fixtureReply ? recordedChat(fixtureReply, replyDelayMs, figureFixes) : undefined,
      });
    },
  };
}
