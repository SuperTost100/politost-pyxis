import type { ChatContext } from "./turn";

/**
 * A chat opened with a pinned context (Chiedi from a quiz result, a lesson, a map, a card) before anything was sent. It is
 * not stored: the chat is a row only once its first message is sent, so leaving it unsent saves nothing and the list
 * never shows an empty chat. Core holds the seed here, under the id the window opened the chat with, until that first
 * message stores it (`ensureChat`), a failed first send puts it back, and the window leaving or the app quitting drops it.
 */
export type PendingChat = {
  title: string;
  /** The chat's `scope_json`, as it will be stored. */
  scope: string;
  subject: string | null;
  context: ChatContext | null;
};

const pending = new Map<string, PendingChat>();

export const pendingChats = {
  get: (chatId: string): PendingChat | undefined => pending.get(chatId),
  set: (chatId: string, chat: PendingChat): void => void pending.set(chatId, chat),
  delete: (chatId: string): boolean => pending.delete(chatId),
};
