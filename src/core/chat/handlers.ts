import type Database from "better-sqlite3";
import { askTurn, listChats, readChat } from "./turn";

export function chatHandlers(db: Database.Database) {
  return {
    list() {
      return listChats(db).map((row) => ({
        id: row.id,
        title: row.title,
        updatedAt: row.updated_at,
      }));
    },
    read(input: { chatId: string }) {
      return readChat(db, input.chatId);
    },
    ask(input: {
      chatId?: string;
      text: string;
      sourceIds?: string[];
      mode?: "solver" | "socratic";
      allowGeneral?: boolean;
      signal?: AbortSignal;
    }) {
      return askTurn(db, input);
    },
  };
}
