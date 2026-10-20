import { createHashRouter, isRouteErrorResponse, Navigate, useNavigate, useRouteError } from "react-router";
import { useTranslation } from "react-i18next";
import type { ComponentType } from "react";
import { ExamsHome } from "../features/home/HomePages";
import { ErrorState } from "../components/ErrorState";
import { errorDetails } from "../lib/errorDetails";
import { rememberDoorPath, Shell } from "./layouts/Shell";

/**
 * The fallback for a page that failed or does not exist. Inside the shell it sits in the page column; a full-screen
 * page has no shell, so it brings its own column.
 */
function RouteError({ standalone }: { standalone?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const error = useRouteError();
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

// Every page but the exam list loads on its first visit, so the window parses less at startup.
function page<K extends string>(
  load: () => Promise<Record<K, ComponentType>>,
  name: K,
) {
  return async () => ({ Component: (await load())[name] });
}
const settings = page(() => import("../features/settings/SettingsPage"), "SettingsPage");
const ask = page(() => import("../features/ask/AskPage"), "AskPage");
const plans = () => import("../features/plans/PlanFrames");
const plan = page(plans, "PlanPage");
const quiz = page(() => import("../features/study/QuizPage"), "QuizPage");
const quizRedo = async () => {
  const { QuizPage } = await import("../features/study/QuizPage");
  return { Component: () => <QuizPage redo /> };
};
const cards = page(() => import("../features/study/CardsPage"), "CardsPage");
const simulation = page(() => import("../features/study/SimulationPage"), "SimulationPage");
const review = page(() => import("../features/study/ReviewPage"), "ReviewPage");

export const router = createHashRouter([
  { path: "/print", lazy: page(() => import("../features/share/PrintPage"), "PrintPage") },
  {
    id: "shell",
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/exams" replace /> },
      { path: "onboarding", lazy: page(() => import("../features/onboarding/OnboardingPage"), "OnboardingPage") },
      { path: "ask", lazy: ask },
      { path: "ask/:chatId", lazy: ask },
      { path: "exams", element: <ExamsHome /> },
      { path: "exams/library", element: <ExamsHome /> },
      { path: "exams/cards", element: <ExamsHome /> },
      { path: "exams/mistakes", element: <ExamsHome /> },
      { path: "exams/planner", lazy: page(() => import("../features/home/PlannerPage"), "PlannerPage") },
      { path: "exams/get", lazy: page(plans, "SharedPlanPage") },
      { path: "maps", lazy: page(() => import("../features/maps/MapsHome"), "MapsHome") },
      { path: "plans/:planId", lazy: plan },
      { path: "plans/:planId/:view", lazy: plan },
      { path: "settings", lazy: settings },
      { path: "settings/subjects", element: <Navigate to="/exams" replace /> },
      { path: "settings/:section", lazy: settings },
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
  { path: "/plans/:planId/redo", lazy: quizRedo },
  { path: "/plans/:planId/past", lazy: quiz },
  { path: "/plans/:planId/cards/:topicId", lazy: cards },
  { path: "/plans/:planId/review", lazy: review },
  { path: "/plans/:planId/review/cards", lazy: cards },
  { path: "/cards/due", lazy: cards },
  { path: "/plans/:planId/simulation", lazy: simulation },
  { path: "/plans/:planId/exam/:attemptId", lazy: simulation },
  { path: "/plans/:planId/map/:topicId", lazy: page(() => import("../features/maps/MapPage"), "MapPage") },
  { path: "/tools/whiteboard", lazy: page(() => import("../features/tools/WhiteboardPage"), "WhiteboardPage") },
  { path: "/tools/graph", lazy: page(() => import("../features/tools/GraphPage"), "GraphPage") },
  { path: "/tools/python", lazy: page(() => import("../features/tools/PythonPage"), "PythonPage") },
].map((route) => ({
  ...route,
  errorElement: <RouteError standalone />,
  // A failing page in the shell keeps the shell around its message.
  children: route.children?.map((child) => ({ ...child, errorElement: <RouteError /> })),
})));

// The page the window opens on, then every page the router reaches, in order. Full-screen pages outside the shell,
// such as a lesson or a map, are not where a door was left.
function remember(state: typeof router.state) {
  if (state.matches.some((match) => match.route.id === "shell"))
    rememberDoorPath(state.location.pathname);
}
remember(router.state);
router.subscribe(remember);
