// Which pages the shell gives their own width. The sidebar's lit row comes from the trail (trail.ts), not from here.

/**
 * A map's page: `/maps/:subjectId/:topicId?`, or the older `/plans/:planId/map/:topicId`, which belongs to Maps
 * although its address starts with the exam's. The Maps list itself, `/maps`, is not one.
 */
export function isMapPath(pathname: string): boolean {
  return /^\/plans\/[^/]+\/map\/|^\/maps\/[^/]+/.test(pathname);
}

/**
 * An exam's own page, `/plans/:planId`, which sets its own width (ExamPage.css). The new-exam wizard, `/plans/new`, has
 * the same shape but is not one: it is a page of its own, and the shell can still be mounted around it while the
 * navigation to it is pending.
 */
export function isExamPagePath(pathname: string): boolean {
  return /^\/plans\/(?!new\/?$)[^/]+\/?$/.test(pathname);
}
