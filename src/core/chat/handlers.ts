import type Database from "better-sqlite3";
import { askTurn, chatContext, chatScope, chatSubject, clearChatContext, deleteChat, heldSources, listChats, rateMessage, readChat, regenerateTurn, renameChat, seedChat } from "./turn";

export function chatHandlers(db: Database.Database, workspace = "", fixtureReply?: string) {
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
        sourceIds: chatScope(db, input.chatId),
        subject: chatSubject(db, input.chatId),
        context: chatContext(db, input.chatId),
        held: heldSources(db, input.chatId),
        messages: readChat(db, input.chatId),
      };
    },
    seed(input: {
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
      deleteChat(db, input.chatId);
      return { ok: true as const };
    },
    regenerate(input: {
      chatId: string;
      sourceIds?: string[];
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
        run: fixtureReply
          ? async () => ({
              text: fixtureReply,
              model: "fixture",
              provider: "fixture",
              inputTokens: 0,
            })
          : undefined,
      });
    },
    ask(input: {
      chatId?: string;
      text: string;
      sourceIds?: string[];
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
        run: fixtureReply
          ? async () => ({
              text: fixtureReply,
              model: "fixture",
              provider: "fixture",
              inputTokens: 0,
            })
          : undefined,
      });
    },
  };
}
