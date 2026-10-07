import { PrintPage } from "../features/share/PrintPage";
import { createHashRouter, Link, Navigate } from "react-router";
import { useTranslation } from "react-i18next";
import { CardsPage } from "../features/study/CardsPage";
import { MapPage } from "../features/maps/MapPage";
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
import { GraphPage } from "../features/tools/GraphPage";
import { PythonPage } from "../features/tools/PythonPage";
import { WhiteboardPage } from "../features/tools/WhiteboardPage";
import { DevGallery } from "../features/jobs/DevGallery";
import { SettingsPage } from "../features/settings/SettingsPage";
import { Shell } from "./layouts/Shell";

function RouteError() {
  const { t } = useTranslation();
  return (
    <main className="empty" style={{ maxWidth: 768, margin: "0 auto", padding: "var(--space-12) var(--space-6)" }}>
      <h1 className="title-2">{t("routeError.title")}</h1>
      <p className="body">{t("routeError.body")}</p>
      <Link to="/exams">{t("onboarding.done")}</Link>
    </main>
  );
}

export const router = createHashRouter([
  { path: "/print", element: <PrintPage /> },
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/exams" replace /> },
      { path: "onboarding", element: <OnboardingPage /> },
      { path: "ask", element: <AskPage /> },
      { path: "ask/:chatId", element: <AskPage /> },
      { path: "exams", element: <ExamsHome /> },
      { path: "exams/library", element: <ExamsHome /> },
      { path: "exams/get", element: <SharedPlanPage /> },
      { path: "plans/:planId", element: <PlanPage /> },
      { path: "plans/:planId/:view", element: <PlanPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "settings/:section", element: <SettingsPage /> },
      { path: "dev/gallery", element: <DevGallery /> },
    ],
  },
  { path: "/plans/new", element: <WizardFrame /> },
  { path: "/plans/new/guided", element: <GuidedPlanPage /> },
  { path: "/plans/:planId/practice/:topicId", element: <PracticePage /> },
  { path: "/plans/:planId/lesson/:topicId", element: <LessonPage /> },
  { path: "/plans/:planId/intro", element: <IntroPage /> },
  { path: "/plans/:planId/diagnostic", element: <QuizPage /> },
  { path: "/plans/:planId/quiz/:topicId", element: <QuizPage /> },
  { path: "/plans/:planId/cards/:topicId", element: <CardsPage /> },
  { path: "/plans/:planId/review", element: <ReviewPage /> },
  { path: "/plans/:planId/review/cards", element: <CardsPage /> },
  { path: "/plans/:planId/simulation", element: <SimulationPage /> },
  { path: "/plans/:planId/exam/:attemptId", element: <SimulationPage /> },
  { path: "/plans/:planId/map/:topicId", element: <MapPage /> },
  { path: "/tools/whiteboard", element: <WhiteboardPage /> },
  { path: "/tools/graph", element: <GraphPage /> },
  { path: "/tools/python", element: <PythonPage /> },
].map((route) => ({ ...route, errorElement: <RouteError /> })));
