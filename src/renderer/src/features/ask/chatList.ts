import { addDays, startOfDay, startOfWeek } from "../../../../shared/local-day";

export type ChatGroup = "today" | "yesterday" | "week" | "older";

const ORDER: ChatGroup[] = ["today", "yesterday", "week", "older"];

/**
 * Splits chats, newest first, under Today, Yesterday, This week and Earlier. "This week" is the calendar week from
 * Monday, less today and yesterday. Empty groups are left out and each keeps its order.
 */
export function groupChats<T extends { updatedAt: number }>(
  chats: T[],
  now = Date.now(),
): Array<{ group: ChatGroup; chats: T[] }> {
  const today = startOfDay(now);
  const yesterday = addDays(now, -1);
  const week = startOfWeek(now);
  const groups: Record<ChatGroup, T[]> = { today: [], yesterday: [], week: [], older: [] };
  for (const chat of chats)
    groups[
      chat.updatedAt >= today
        ? "today"
        : chat.updatedAt >= yesterday
          ? "yesterday"
          : chat.updatedAt >= week
            ? "week"
            : "older"
    ].push(chat);
  return ORDER.filter((group) => groups[group].length > 0).map((group) => ({ group, chats: groups[group] }));
}
