import type { JobView } from "../../../../shared/ipc";

const sourceKinds = new Set(["source-import", "source-import-vision", "source-index", "source-ocr", "library-sort"]);
const planKinds = new Set(["plan-build", "plan-rebuild"]);
/** Jobs that save items citing source passages, so a source's citation counts change when they end. */
const citingKinds = new Set(["plan-build", "plan-rebuild", "quiz-build", "quiz-replace", "gap-drill"]);
/** Jobs that save flashcards, so the Flashcard section's lists and due counts change when they end. */
const cardKinds = new Set(["cards-build", "cards-propose", "plan-build", "plan-rebuild"]);
const finished = new Set<JobView["state"]>(["succeeded", "failed", "cancelled", "interrupted"]);

/** A query family to mark stale; `refetch: false` leaves the refetch to the next visit. */
export type StaleFamily = { key: string; refetch: boolean };

/**
 * The query families a job update makes stale. Reading plans can take seconds on a large workspace, so the plan
 * families refresh once, when a job ends, rather than at every step.
 */
export function staleFamilies(job: Pick<JobView, "kind" | "state">): StaleFamily[] {
  const keys = ["jobs"];
  if (sourceKinds.has(job.kind)) keys.push("sources", "source-chapters", "source-meta", "source-details");
  if (planKinds.has(job.kind)) keys.push("plan-build");
  // An open map page reads its build and its maps from these, so a build that starts, is stopped or resumed in Attività
  // shows there at once, and the finished map appears without a reload.
  if (job.kind === "map-build") keys.push("map-build");
  if (job.kind === "map-build" && finished.has(job.state)) keys.push("maps", "map", "maps-all");
  if (job.kind === "ocr-data-download") keys.push("ocr-data");
  if (job.kind === "embedding-download") keys.push("embedding");
  // Choosing the subjects of Library files can make new subjects.
  if (job.kind === "library-sort") keys.push("subjects");
  // A job that ends joins or leaves the jobs list's "finished today" group.
  if (finished.has(job.state)) keys.push("jobs-finished", "plans", "plan");
  if (finished.has(job.state) && cardKinds.has(job.kind)) keys.push("card-sections");
  if (finished.has(job.state) && citingKinds.has(job.kind) && !keys.includes("source-details")) keys.push("source-details");
  const families = keys.map((key) => ({ key, refetch: true }));
  if (finished.has(job.state)) families.push({ key: "series", refetch: false });
  return families;
}

/**
 * Collects stale families and hands them over together once updates pause for `wait` ms, or at the latest `maxWait`
 * ms after the first one, so a steady stream of updates still refreshes.
 */
export function staleBatcher(
  flush: (families: StaleFamily[]) => void,
  wait = 250,
  maxWait = 1000,
) {
  const pending = new Map<string, boolean>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first = 0;
  const run = () => {
    timer = undefined;
    const families = [...pending].map(([key, refetch]) => ({ key, refetch }));
    pending.clear();
    flush(families);
  };
  return {
    add(families: StaleFamily[]) {
      for (const { key, refetch } of families) pending.set(key, refetch || pending.get(key) === true);
      if (timer === undefined) first = Date.now();
      clearTimeout(timer);
      timer = setTimeout(run, Math.max(0, Math.min(wait, first + maxWait - Date.now())));
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}
