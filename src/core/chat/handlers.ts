import type Database from "better-sqlite3";
import { askTurn, chatScope, deleteChat, listChats, rateMessage, readChat, renameChat } from "./turn";

export function chatHandlers(db: Database.Database, fixtureReply?: string) {
  return {
    list() {
      return listChats(db).map((row) => ({
        id: row.id,
        title: row.title,
        updatedAt: row.updated_at,
      }));
    },
    read(input: { chatId: string }) {
      return { sourceIds: chatScope(db, input.chatId), messages: readChat(db, input.chatId) };
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
    ask(input: {
      chatId?: string;
      text: string;
      sourceIds?: string[];
      mode?: "solver" | "socratic";
      allowGeneral?: boolean;
      signal?: AbortSignal;
    }) {
      return askTurn(db, {
        ...input,
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
