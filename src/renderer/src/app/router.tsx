import { PrintPage } from "../features/share/PrintPage";
import { createHashRouter, isRouteErrorResponse, Navigate, useNavigate, useRouteError } from "react-router";
import { useTranslation } from "react-i18next";
import type { ComponentType } from "react";
import { CardsPage } from "../features/study/CardsPage";
import { LessonPage } from "../features/study/LessonPage";
import { IntroPage } from "../features/study/IntroPage";
import { PracticePage } from "../features/study/PracticePage";
import { SimulationPage } from "../features/study/SimulationPage";
import { QuizPage } from "../features/study/QuizPage";
import { ReviewPage } from "../features/study/ReviewPage";
import { OnboardingPage } from "../features/onboarding/OnboardingPage";
import { AskPage } from "../features/ask/AskPage";
import { ExamsHome } from "../features/home/HomePages";
import {
  GuidedPlanPage,
  PlanPage,
  SharedPlanPage,
  WizardFrame,
} from "../features/plans/PlanFrames";
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

// Pages a student opens rarely load on first visit, so the window parses less at startup.
function page<K extends string>(
  load: () => Promise<Record<K, ComponentType>>,
  name: K,
) {
  return async () => ({ Component: (await load())[name] });
}
const settings = page(() => import("../features/settings/SettingsPage"), "SettingsPage");

export const router = createHashRouter([
  { path: "/print", element: <PrintPage /> },
  {
    id: "shell",
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/exams" replace /> },
      { path: "onboarding", element: <OnboardingPage /> },
      { path: "ask", element: <AskPage /> },
      { path: "ask/:chatId", element: <AskPage /> },
      { path: "exams", element: <ExamsHome /> },
      { path: "exams/library", element: <ExamsHome /> },
      { path: "exams/cards", element: <ExamsHome /> },
      { path: "exams/mistakes", element: <ExamsHome /> },
      { path: "exams/planner", lazy: page(() => import("../features/home/PlannerPage"), "PlannerPage") },
      { path: "exams/get", element: <SharedPlanPage /> },
      { path: "maps", lazy: page(() => import("../features/maps/MapsHome"), "MapsHome") },
      { path: "plans/:planId", element: <PlanPage /> },
      { path: "plans/:planId/:view", element: <PlanPage /> },
      { path: "settings", lazy: settings },
      { path: "settings/subjects", element: <Navigate to="/exams" replace /> },
      { path: "settings/:section", lazy: settings },
      { path: "dev/gallery", lazy: page(() => import("../features/jobs/DevGallery"), "DevGallery") },
      { path: "*", element: <RouteError /> },
    ],
  },
  { path: "/plans/new", element: <WizardFrame /> },
  { path: "/plans/new/guided", element: <GuidedPlanPage /> },
  { path: "/plans/:planId/practice/:topicId", element: <PracticePage /> },
  { path: "/plans/:planId/lesson/:topicId", element: <LessonPage /> },
  { path: "/plans/:planId/intro", element: <IntroPage /> },
  { path: "/plans/:planId/diagnostic", element: <QuizPage /> },
  { path: "/plans/:planId/quiz/:topicId", element: <QuizPage /> },
  { path: "/plans/:planId/redo", element: <QuizPage redo /> },
  { path: "/plans/:planId/past", element: <QuizPage /> },
  { path: "/plans/:planId/cards/:topicId", element: <CardsPage /> },
  { path: "/plans/:planId/review", element: <ReviewPage /> },
  { path: "/plans/:planId/review/cards", element: <CardsPage /> },
  { path: "/cards/due", element: <CardsPage /> },
  { path: "/plans/:planId/simulation", element: <SimulationPage /> },
  { path: "/plans/:planId/exam/:attemptId", element: <SimulationPage /> },
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
