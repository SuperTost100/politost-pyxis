import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { SkeletonRows } from "../../components/Skeleton";
import { useSubPageBack } from "../home/subPageBack";
import "../home/HomePages.css";

// The browser renders Markdown and math, which load with its page rather than with the window.
const CardBrowser = lazy(() =>
  import("../home/CardBrowser").then((module) => ({ default: module.CardBrowser })),
);

/**
 * Every flashcard, as a page of the Flashcard section at /flashcards/all. Opened from an exam's page
 * (`?exam=<id>`), it is filtered to that exam and goes back to it; opened from a chat reply that made cards
 * (`?made=<result id>`), it lists those cards.
 */
export function CardsHome() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const exam = params.get("exam") ?? undefined;
  // «Apri» on the flashcards a chat reply created opens the browser to those cards (`?made=<result id>`).
  const made = params.get("made") ?? undefined;
  const back = useSubPageBack();
  // The browser draws the head, which holds the page's menu; until it loads, the head shows without its dots.
  return (
    <Suspense
      fallback={
        <div>
          {back}
          <h1 className="title-1 px-subpage-title">{t("exams.allCards")}</h1>
          <SkeletonRows label={t("components.loading")} />
        </div>
      }
    >
      <CardBrowser planId={exam} made={made} back={back} title={t("exams.allCards")} />
    </Suspense>
  );
}
