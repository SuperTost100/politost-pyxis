import { startOfDay, startOfWeek } from "../../../../shared/local-day";

export type ChatGroup = "today" | "week" | "older";

/** Start of the local day, and of the week on Monday, so "This week" means the calendar week. */
function boundaries(now: number) {
  return { today: startOfDay(now), week: startOfWeek(now) };
}

/** Splits chats, newest first, under Today, This week and Older. Empty groups are left out and each keeps its order. */
export function groupChats<T extends { updatedAt: number }>(
  chats: T[],
  now = Date.now(),
): Array<{ group: ChatGroup; chats: T[] }> {
  const { today, week } = boundaries(now);
  const groups: Record<ChatGroup, T[]> = { today: [], week: [], older: [] };
  for (const chat of chats)
    groups[chat.updatedAt >= today ? "today" : chat.updatedAt >= week ? "week" : "older"].push(chat);
  return (["today", "week", "older"] as const)
    .filter((group) => groups[group].length > 0)
    .map((group) => ({ group, chats: groups[group] }));
}

/**
 * The subjects chats are filed under, in the order of the subject list; a subject since removed from the list goes
 * last.
 */
export function chatSubjects(
  chats: Array<{ subject: string | null }>,
  order: Array<{ name: string }>,
): string[] {
  const used = new Set(chats.map((chat) => chat.subject).filter((name): name is string => Boolean(name)));
  const known = order.map((subject) => subject.name).filter((name) => used.has(name));
  const rest = [...used].filter((name) => !known.includes(name)).sort((a, b) => a.localeCompare(b));
  return [...known, ...rest];
}

/** Rows filed under `subject`. A search hit carries no subject, so it is looked up in the chat list by id. */
export function filterBySubject<T extends { id: string }>(
  rows: T[],
  subject: string,
  chats: Array<{ id: string; subject: string | null }>,
): T[] {
  if (!subject) return rows;
  const filed = new Set(chats.filter((chat) => chat.subject === subject).map((chat) => chat.id));
  return rows.filter((row) => filed.has(row.id));
}
