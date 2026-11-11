import type { QueryClient } from "@tanstack/react-query";

/** Every query family whose data carries a subject's name: the subject list and what shows a subject beside its data. */
const NAMED = [
  "subjects",
  "sources",
  "plans",
  "plan",
  "chats",
  "chat",
  "cards-everywhere",
  "subject-cards",
  "card-browse",
  "map-scope",
] as const;

/**
 * After a subject is added, renamed, removed or reordered: reads again each query that shows a subject's name (window
 * focus does not, it is off), so the sidebar, the exams, the Library, the cards and the maps header all say the same.
 * Add a family here when a new query shows a subject's name.
 */
export function refreshSubjects(client: Pick<QueryClient, "invalidateQueries">): Promise<unknown> {
  return Promise.all(NAMED.map((key) => client.invalidateQueries({ queryKey: [key] })));
}
