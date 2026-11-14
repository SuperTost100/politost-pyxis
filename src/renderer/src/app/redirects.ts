import { redirect, type LoaderFunctionArgs } from "react-router";

/**
 * The old address of the flashcard browser, /exams/cards, leads to /flashcards/all with its search (`?exam=<id>`). It is a
 * `redirect`, not a `replace`: a push to the old address lands as one push to the new one, so the page it came from stays
 * the origin of the browser's back control.
 */
export const allCardsRedirect = ({ request }: LoaderFunctionArgs) =>
  redirect(`/flashcards/all${new URL(request.url).search}`);
