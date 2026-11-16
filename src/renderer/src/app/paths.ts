// The one page whose height the shell lets fill the window. The sidebar's lit row comes from the trail (trail.ts), not from here.

/**
 * A map's page: `/maps/:subjectId/:topicId?`, or the older `/plans/:planId/map/:topicId`, which belongs to Maps
 * although its address starts with the exam's. The Maps list itself, `/maps`, is not one.
 */
export function isMapPath(pathname: string): boolean {
  return /^\/plans\/[^/]+\/map\/|^\/maps\/[^/]+/.test(pathname);
}
