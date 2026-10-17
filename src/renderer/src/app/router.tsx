import { createHashRouter, Link, Navigate } from "react-router";
import { useTranslation } from "react-i18next";
import type { ComponentType } from "react";
import { ExamsHome } from "../features/home/HomePages";
import { Shell } from "./layouts/Shell";

function RouteError() {
  const { t } = useTranslation();
  return (
    <main className="empty" style={{ maxWidth: 768, margin: "0 auto", padding: "var(--space-12) var(--space-6)" }}>
      <h1 className="title-2">{t("routeError.title")}</h1>
      <p className="body">{t("routeError.body")}</p>
      <Link to="/exams">{t("routeError.home")}</Link>
    </main>
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
const cards = page(() => import("../features/study/CardsPage"), "CardsPage");
const simulation = page(() => import("../features/study/SimulationPage"), "SimulationPage");
const review = page(() => import("../features/study/ReviewPage"), "ReviewPage");

export const router = createHashRouter([
  { path: "/print", lazy: page(() => import("../features/share/PrintPage"), "PrintPage") },
  {
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
      { path: "exams/get", lazy: page(plans, "SharedPlanPage") },
      { path: "plans/:planId", lazy: plan },
      { path: "plans/:planId/:view", lazy: plan },
      { path: "settings", lazy: settings },
      { path: "settings/subjects", element: <Navigate to="/exams" replace /> },
      { path: "settings/:section", lazy: settings },
      { path: "dev/gallery", lazy: page(() => import("../features/jobs/DevGallery"), "DevGallery") },
    ],
  },
  { path: "/plans/new", lazy: page(plans, "WizardFrame") },
  { path: "/plans/new/guided", lazy: page(plans, "GuidedPlanPage") },
  { path: "/plans/:planId/practice/:topicId", lazy: page(() => import("../features/study/PracticePage"), "PracticePage") },
  { path: "/plans/:planId/lesson/:topicId", lazy: page(() => import("../features/study/LessonPage"), "LessonPage") },
  { path: "/plans/:planId/intro", lazy: page(() => import("../features/study/IntroPage"), "IntroPage") },
  { path: "/plans/:planId/diagnostic", lazy: quiz },
  { path: "/plans/:planId/quiz/:topicId", lazy: quiz },
  { path: "/plans/:planId/cards/:topicId", lazy: cards },
  { path: "/plans/:planId/review", lazy: review },
  { path: "/plans/:planId/review/cards", lazy: cards },
  { path: "/plans/:planId/simulation", lazy: simulation },
  { path: "/plans/:planId/exam/:attemptId", lazy: simulation },
  { path: "/plans/:planId/map/:topicId", lazy: page(() => import("../features/maps/MapPage"), "MapPage") },
  { path: "/tools/whiteboard", lazy: page(() => import("../features/tools/WhiteboardPage"), "WhiteboardPage") },
  { path: "/tools/graph", lazy: page(() => import("../features/tools/GraphPage"), "GraphPage") },
  { path: "/tools/python", lazy: page(() => import("../features/tools/PythonPage"), "PythonPage") },
].map((route) => ({ ...route, errorElement: <RouteError /> })));
