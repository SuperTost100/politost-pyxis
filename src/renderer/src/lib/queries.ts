import { queryOptions, useQuery } from "@tanstack/react-query";
import { invoke } from "./ipc";

// The reads several screens share, written once so their keys stay the ones that writes and job updates invalidate
// (features/jobs/jobInvalidation.ts). Spread one into useQuery to add options: `useQuery({ ...sourcesQuery, enabled })`.

export const profileQuery = queryOptions({
  queryKey: ["profile"],
  queryFn: () => invoke("profile.get", {}),
});

export const plansQuery = queryOptions({
  queryKey: ["plans"],
  queryFn: () => invoke("plans.list", {}),
});

export const sourcesQuery = queryOptions({
  queryKey: ["sources"],
  queryFn: () => invoke("sources.list", {}),
});

export const subjectsQuery = queryOptions({
  queryKey: ["subjects"],
  queryFn: () => invoke("subjects.list", {}),
});

export const chatsQuery = queryOptions({
  queryKey: ["chats"],
  queryFn: () => invoke("chats.list", {}),
});

export const enginesQuery = queryOptions({
  queryKey: ["engines"],
  queryFn: () => invoke("engines.overview", {}),
});

/** The engines the student lets Pyxis use; `allowed: null` is automatic. */
export const engineChoiceQuery = queryOptions({
  queryKey: ["engine-choice"],
  queryFn: () => invoke("engines.choice", {}),
});

export const engineFeaturesQuery = queryOptions({
  queryKey: ["engine-features"],
  queryFn: () => invoke("engines.features", {}),
});

export const planQuery = (planId: string) =>
  queryOptions({
    queryKey: ["plan", planId],
    queryFn: () => invoke("plans.read", { planId }),
  });

export const recommendQuery = (planId: string) =>
  queryOptions({
    queryKey: ["recommend", planId],
    queryFn: () => invoke("plans.recommend", { planId }),
  });

/** A topic's lesson parts, or null in `outline` before the topic is planned. Reads only. */
export const partsQuery = (planId: string, topicId: string) =>
  queryOptions({
    queryKey: ["parts", planId, topicId],
    queryFn: () => invoke("study.parts", { planId, topicId }),
  });

/** The day each topic should be done at the session planner's pace, or null when the planner has no days for it. */
export const scheduleQuery = (planId: string) =>
  queryOptions({
    queryKey: ["schedule", planId],
    queryFn: () => invoke("plans.schedule", { planId }),
  });

/**
 * The exam's open gaps, most serious first. A drill closes gaps while the student is on other pages, so the read is made
 * again each time a page that shows it opens, however recently it was made. Its key starts with "plans", so everything
 * that refreshes the exam refreshes it too.
 */
export const openGapsQuery = (planId: string) =>
  queryOptions({
    queryKey: ["plans", "openGaps", planId],
    queryFn: () => invoke("plans.openGaps", { planId }),
    refetchOnMount: "always",
  });

/**
 * What is true of one gap: open or closed, and the gap it merged into if it did. It is read again as the page that shows
 * it opens, since answers close a gap while the student is elsewhere. Its key starts with "plans" like the list's.
 */
export const gapStateQuery = (gapId: string) =>
  queryOptions({
    queryKey: ["plans", "gapState", gapId],
    queryFn: () => invoke("plans.gapState", { gapId }),
    refetchOnMount: "always",
  });

/** The three rings of every built exam (Preparazione, Percorso, Oggi), its next step and its due cards. */
export const ringsQuery = queryOptions({
  queryKey: ["plans", "rings"],
  queryFn: () => invoke("plans.rings", {}),
});

/** Flashcards due with no exam: the part of the daily review that the rings leave out. */
export const examlessDueQuery = queryOptions({
  queryKey: ["plans", "examlessDue"],
  queryFn: () => invoke("plans.examlessDue", {}),
});

/** The session planner: the weekly hours, the hours the exams need, and the weeks. */
/** The Flashcard section's subjects, exams, topics and due counts, also listed by the search. */
export const cardSectionsQuery = queryOptions({
  queryKey: ["card-sections"],
  queryFn: () => invoke("study.cardSections", {}),
});

export const plannerQuery = queryOptions({
  queryKey: ["plans", "planner"],
  queryFn: () => invoke("plans.planner", {}),
});

export const pastPapersQuery = (planId: string) =>
  queryOptions({
    queryKey: ["past-papers", planId],
    queryFn: () => invoke("study.pastPapers", { planId }),
  });

export function useProfile() {
  return useQuery(profileQuery);
}

export function usePlans(enabled = true) {
  return useQuery({ ...plansQuery, enabled });
}

export function useSources(enabled = true) {
  return useQuery({ ...sourcesQuery, enabled });
}

export function useSubjects() {
  return useQuery(subjectsQuery);
}

export function useChats() {
  return useQuery(chatsQuery);
}

/** One plan, read once `planId` is known. */
export function usePlan(planId: string | null | undefined, enabled = true) {
  return useQuery({ ...planQuery(planId ?? ""), enabled: enabled && Boolean(planId) });
}

/** The plan's next step, read once `planId` is known. */
export function useRecommend(planId: string | undefined) {
  return useQuery({ ...recommendQuery(planId ?? ""), enabled: Boolean(planId) });
}
