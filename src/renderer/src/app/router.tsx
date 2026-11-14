import {
  createHashRouter,
  isRouteErrorResponse,
  replace,
  useNavigate,
  useRouteError,
} from "react-router";
import { useTranslation } from "react-i18next";
import { useEffect, type ComponentType } from "react";
import { AskPage } from "../features/ask/AskPage";
import { ErrorState } from "../components/ErrorState";
import { errorDetails } from "../lib/errorDetails";
import { reportError } from "../lib/errorReports";
import { trackHistory } from "./history";
import { allCardsRedirect } from "./redirects";
import { Shell } from "./layouts/Shell";

/**
 * The fallback for a page that failed or does not exist. Inside the shell it sits in the page column; a full-screen
 * page has no shell, so it brings its own column.
 */
function RouteError({ standalone }: { standalone?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const error = useRouteError();
  // A page that threw while rendering ends here rather than at the window's error handler. A missing page (a route
  // error response) is not a crash.
  useEffect(() => {
    if (!isRouteErrorResponse(error)) reportError(error);
  }, [error]);
  const details = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`.trim()
    : errorDetails(error);
  const state = (
    <ErrorState
      title={t("routeError.title")}
      titleLevel={1}
      action={{ label: t("nav.toExams"), onClick: () => navigate("/exams") }}
      details={details}
    >
      {t("routeError.body")}
    </ErrorState>
  );
  return standalone ? (
    <main className="column" style={{ paddingTop: "var(--space-12)" }}>
      {state}
    </main>
  ) : (
    state
  );
}

// Every page but Chiedi, where the window opens, loads on its first visit, so the window parses less at startup. Until
// a route's page has loaded, the router keeps the previous page on screen, so a page with tabs or an optional id is one
// route: moving between its tabs never waits for a load. Redirects are loaders, not rendered <Navigate>s: a redirect that renders
// late would cancel a navigation started before it, such as one still loading its page.
function page<K extends string>(
  load: () => Promise<Record<K, ComponentType>>,
  name: K,
) {
  return async () => ({ Component: (await load())[name] });
}
const plans = () => import("../features/plans/PlanFrames");
const examsHome = page(() => import("../features/home/HomePages"), "ExamsHome");
const quiz = page(() => import("../features/study/QuizPage"), "QuizPage");
const quizRedo = async () => {
  const { QuizPage } = await import("../features/study/QuizPage");
  return { Component: () => <QuizPage redo /> };
};
const reviewQuestions = async () => {
  const { QuizPage } = await import("../features/study/QuizPage");
  return { Component: () => <QuizPage review /> };
};
const cards = page(() => import("../features/study/CardsPage"), "CardsPage");
const simulation = page(() => import("../features/study/SimulationPage"), "SimulationPage");
const review = page(() => import("../features/study/ReviewPage"), "ReviewPage");
const mapPage = page(() => import("../features/maps/MapPage"), "MapPage");

export const router = createHashRouter([
  {
    id: "shell",
    path: "/",
    element: <Shell />,
    children: [
      { index: true, loader: () => replace("/ask") },
      { path: "onboarding", lazy: page(() => import("../features/onboarding/OnboardingPage"), "OnboardingPage") },
      { path: "ask/:chatId?", element: <AskPage /> },
      { path: "exams", lazy: examsHome },
      { path: "exams/library", lazy: examsHome },
      // The browser of every flashcard moved to /flashcards/all; its old address redirects (redirects.ts).
      { path: "exams/cards", loader: allCardsRedirect },
      { path: "exams/mistakes", lazy: examsHome },
      // The session planner's page is gone: the exam rings show the plan, and weekly hours live in exam settings.
      { path: "exams/planner", loader: () => replace("/exams") },
      { path: "exams/get", lazy: page(plans, "SharedPlanPage") },
      { path: "maps", lazy: page(() => import("../features/maps/MapsHome"), "MapsHome") },
      { path: "flashcards", lazy: page(() => import("../features/flashcards/FlashcardsHome"), "FlashcardsHome") },
      { path: "flashcards/all", lazy: page(() => import("../features/flashcards/AllCards"), "CardsHome") },
      { path: "plans/:planId/settings", lazy: page(plans, "ExamSettingsPage") },
      // A map belongs to Maps and opens inside the shell, by its subject and, for a topic's map, the topic. The exam's
      // address still opens a topic's map, for older links and for an exam that has no subject.
      { path: "maps/:subjectId/:topicId?", lazy: mapPage },
      { path: "plans/:planId/map/:topicId", lazy: mapPage },
      { path: "plans/:planId/:view?", lazy: page(plans, "PlanPage") },
      { path: "settings/subjects", loader: () => replace("/exams") },
      { path: "settings/:section?", lazy: page(() => import("../features/settings/SettingsPage"), "SettingsPage") },
      { path: "dev/gallery", lazy: page(() => import("../features/jobs/DevGallery"), "DevGallery") },
      { path: "*", element: <RouteError /> },
    ],
  },
  { path: "/plans/new", lazy: page(plans, "WizardFrame") },
  { path: "/plans/new/guided", lazy: page(plans, "GuidedPlanPage") },
  { path: "/plans/:planId/practice/:topicId", lazy: page(() => import("../features/study/PracticePage"), "PracticePage") },
  { path: "/plans/:planId/lesson/:topicId", lazy: page(() => import("../features/study/LessonPage"), "LessonPage") },
  { path: "/plans/:planId/intro", lazy: page(() => import("../features/study/IntroPage"), "IntroPage") },
  { path: "/plans/:planId/diagnostic", lazy: quiz },
  { path: "/plans/:planId/quiz/:topicId", lazy: quiz },
  { path: "/plans/:planId/gap/:gapId", lazy: page(() => import("../features/study/GapPage"), "GapPage") },
  { path: "/plans/:planId/redo", lazy: quizRedo },
  { path: "/plans/:planId/past", lazy: quiz },
  { path: "/plans/:planId/cards/:topicId", lazy: cards },
  { path: "/plans/:planId/review", lazy: review },
  { path: "/plans/:planId/review/cards", lazy: cards },
  { path: "/plans/:planId/review/questions", lazy: reviewQuestions },
  { path: "/cards/due", lazy: cards },
  { path: "/cards/subject/:subjectId", lazy: cards },
  { path: "/plans/:planId/simulation", lazy: simulation },
  { path: "/plans/:planId/exam/:attemptId", lazy: simulation },
  { path: "/tools/whiteboard", lazy: page(() => import("../features/tools/WhiteboardPage"), "WhiteboardPage") },
  { path: "/tools/graph", lazy: page(() => import("../features/tools/GraphPage"), "GraphPage") },
  { path: "/tools/python", lazy: page(() => import("../features/tools/PythonPage"), "PythonPage") },
].map((route) => ({
  ...route,
  errorElement: <RouteError standalone />,
  // A failing page in the shell keeps the shell around its message.
  children: route.children?.map((child) => ({ ...child, errorElement: <RouteError /> })),
})));

// The trail of the window's history (history.ts): every navigation the router finishes, from the page the window opens
// on, so a page's back control, the sidebar's lit row and the menu's Avanti read the same record.
trackHistory(router);
