/** What a link to a map page needs: a topic map's exam and topic, a whole subject's subject, and which map to show. */
export type MapLink = {
  subjectId?: string | null;
  planId?: string | null;
  topicId?: string | null;
  id?: string;
};

/**
 * Where a map opens, inside the shell under Mappe. A map of a subject's topic opens at `/maps/:subjectId/:topicId` and
 * a whole subject's at `/maps/:subjectId`. A topic whose exam has no subject keeps the exam's address,
 * `/plans/:planId/map/:topicId`, which also still opens every older link.
 */
export function mapPath(map: MapLink): string {
  const query = `?from=maps${map.id ? `&map=${encodeURIComponent(map.id)}` : ""}`;
  if (map.topicId && !map.subjectId && map.planId) return `/plans/${map.planId}/map/${map.topicId}${query}`;
  const subject = `/maps/${encodeURIComponent(map.subjectId ?? "")}`;
  return `${map.topicId ? `${subject}/${map.topicId}` : subject}${query}`;
}
