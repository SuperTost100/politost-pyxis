import { matchPath } from "react-router";
import type { PlaceName } from "./trail";

/**
 * Every kind of page, with what a back control elsewhere calls it and its parent: where its own back control leads
 * when there is no page behind it (the first page of a window, a reminder, a file, a trail that was lost). A page
 * whose name is the student's own words (an exam's title, a topic, a map) writes it on its visit (`usePlace`); its
 * name here is the kind of page, for a visit left before the page knew it.
 */
export type Place = {
  name: PlaceName | null;
  parent: { to: string; name: PlaceName } | null;
};

type Row = { path: string; place: (params: Record<string, string | undefined>, search: URLSearchParams) => Place };

const key = (name: string): PlaceName => ({ key: name });
const exams = { to: "/exams", name: key("doors.exams") };
const flashcards = { to: "/flashcards", name: key("flashcards.title") };
const ask = { to: "/ask", name: key("doors.ask") };
const exam = (planId: string | undefined) => ({ to: `/plans/${planId ?? ""}`, name: key("places.exam") });
/** A page under an exam, which goes back to the exam's page. */
const underExam = (name: PlaceName) => (params: Record<string, string | undefined>) => ({ name, parent: exam(params.planId) });
/** A page reached from an exam or not: `?exam=<id>` names the exam it came from. */
const examOr = (fallback: Place["parent"], search: URLSearchParams) => {
  const planId = search.get("exam");
  return planId && planId !== "none" ? exam(planId) : fallback;
};

/** Every flashcard: back to the Flashcard section, or to the exam it was narrowed to. */
const allCards = (search: URLSearchParams): Place => ({ name: key("exams.allCards"), parent: examOr(flashcards, search) });

/** In the router's order of matching: a fixed segment comes before a parameter in the same place. */
const rows: Row[] = [
  { path: "/onboarding", place: (_, search) => ({ name: null, parent: search.get("again") ? { to: "/settings/profile", name: key("settings.title") } : null }) },
  { path: "/ask/:chatId?", place: (params) => ({ name: params.chatId ? key("places.chat") : key("doors.ask"), parent: null }) },
  { path: "/exams", place: () => ({ name: key("doors.exams"), parent: null }) },
  { path: "/exams/library", place: () => ({ name: key("nav.library"), parent: null }) },
  // The old address redirects to /flashcards/all and keeps its row, for a visit recorded before the move.
  { path: "/exams/cards", place: (_, search) => allCards(search) },
  { path: "/exams/mistakes", place: (_, search) => ({ name: key("mistakes.title"), parent: examOr(exams, search) }) },
  { path: "/exams/planner", place: () => ({ name: key("doors.exams"), parent: null }) },
  { path: "/exams/get", place: () => ({ name: key("shared.title"), parent: exams }) },
  { path: "/maps", place: () => ({ name: key("doors.maps"), parent: null }) },
  { path: "/flashcards", place: () => ({ name: key("flashcards.title"), parent: null }) },
  { path: "/flashcards/all", place: (_, search) => allCards(search) },
  { path: "/plans/new", place: () => ({ name: key("wizard.title"), parent: exams }) },
  { path: "/plans/new/guided", place: () => ({ name: key("wizard.title"), parent: exams }) },
  { path: "/plans/:planId/settings", place: underExam(key("planOverview.settings")) },
  {
    path: "/maps/:subjectId/:topicId?",
    place: (params) => ({
      name: key("map.title"),
      // The pathname's segment is already encoded, which a query value accepts as it is.
      parent: { to: `/maps?subject=${params.subjectId ?? ""}`, name: key("doors.maps") },
    }),
  },
  { path: "/plans/:planId/map/:topicId", place: () => ({ name: key("map.title"), parent: { to: "/maps", name: key("doors.maps") } }) },
  { path: "/plans/:planId/practice/:topicId", place: underExam(key("places.practice")) },
  { path: "/plans/:planId/lesson/:topicId", place: underExam(key("lesson.title")) },
  { path: "/plans/:planId/intro", place: underExam(key("plans.intro")) },
  { path: "/plans/:planId/diagnostic", place: underExam(key("quiz.diagnosticTitle")) },
  { path: "/plans/:planId/quiz/:topicId", place: underExam(key("quiz.title")) },
  { path: "/plans/:planId/redo", place: underExam(key("mistakes.redoTitle")) },
  { path: "/plans/:planId/past", place: underExam(key("pastPapers.title")) },
  { path: "/plans/:planId/cards/:topicId", place: underExam(key("cards.title")) },
  { path: "/plans/:planId/review", place: underExam(key("cards.reviewTitle")) },
  {
    path: "/plans/:planId/review/cards",
    place: (params) => ({ name: key("cards.reviewTitle"), parent: { to: `/plans/${params.planId ?? ""}/review`, name: key("cards.reviewTitle") } }),
  },
  {
    path: "/plans/:planId/review/questions",
    place: (params) => ({ name: key("cards.reviewTitle"), parent: { to: `/plans/${params.planId ?? ""}/review`, name: key("cards.reviewTitle") } }),
  },
  { path: "/plans/:planId/simulation", place: underExam(key("simulation.title")) },
  { path: "/plans/:planId/exam/:attemptId", place: underExam(key("simulation.title")) },
  {
    path: "/plans/:planId/:view?",
    place: (params) =>
      params.view === "sources"
        ? { name: key("examPage.material"), parent: exam(params.planId) }
        : { name: key("places.exam"), parent: exams },
  },
  { path: "/cards/due", place: (_, search) => ({ name: key("oggi.cardsTitle"), parent: examOr(flashcards, search) }) },
  { path: "/cards/subject/:subjectId", place: () => ({ name: key("cards.title"), parent: flashcards }) },
  { path: "/settings/subjects", place: () => ({ name: key("doors.exams"), parent: null }) },
  { path: "/settings/:section?", place: () => ({ name: key("settings.title"), parent: ask }) },
  { path: "/tools/whiteboard", place: () => ({ name: key("tools.whiteboardTitle"), parent: ask }) },
  { path: "/tools/graph", place: () => ({ name: key("graph.title"), parent: ask }) },
  { path: "/tools/python", place: () => ({ name: key("python.title"), parent: ask }) },
  { path: "/dev/gallery", place: () => ({ name: null, parent: null }) },
  { path: "*", place: () => ({ name: null, parent: null }) },
];

/** The route patterns the table covers, for the test that holds it to the router. */
export const placePaths = rows.map((row) => row.path);

/** The place of a path (pathname and search). */
export function placeOf(path: string): Place {
  const [pathname = "/", search = ""] = path.split("?");
  for (const row of rows) {
    const match = row.path === "*" ? null : matchPath({ path: row.path, end: true }, pathname);
    if (match) return row.place(match.params, new URLSearchParams(search));
  }
  return { name: null, parent: null };
}
