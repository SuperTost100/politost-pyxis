import { createHashRouter, Navigate } from "react-router";
import { CardsPage } from "../features/study/CardsPage";
import { LessonPage } from "../features/study/LessonPage";
import { PracticePage } from "../features/study/PracticePage";
import { QuizPage } from "../features/study/QuizPage";
import { OnboardingPage } from "../features/onboarding/OnboardingPage";
import { AskPage } from "../features/ask/AskPage";
import { ExamsHome } from "../features/home/HomePages";
import {
  PlanPage,
  SharedPlanPage,
  WhiteboardFrame,
  WizardFrame,
} from "../features/plans/PlanFrames";
import { DevGallery } from "../features/jobs/DevGallery";
import { SettingsPage } from "../features/settings/SettingsPage";
import { Shell } from "./layouts/Shell";

export const router = createHashRouter([
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
      { path: "settings", element: <SettingsPage /> },
      { path: "settings/:section", element: <SettingsPage /> },
      { path: "dev/gallery", element: <DevGallery /> },
    ],
  },
  { path: "/plans/new", element: <WizardFrame /> },
  { path: "/plans/:planId", element: <PlanPage /> },
  { path: "/plans/:planId/practice/:topicId", element: <PracticePage /> },
  { path: "/plans/:planId/lesson/:topicId", element: <LessonPage /> },
  { path: "/plans/:planId/quiz/:topicId", element: <QuizPage /> },
  { path: "/plans/:planId/cards/:topicId", element: <CardsPage /> },
  { path: "/tools/whiteboard", element: <WhiteboardFrame /> },
]);
