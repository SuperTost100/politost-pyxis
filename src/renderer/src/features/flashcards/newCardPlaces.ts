import type { QueryClient } from "@tanstack/react-query";
import { invoke } from "../../lib/ipc";
import { readAhead, whenRead } from "./placesRead";

/**
 * The new-flashcard dialog's choices: its subjects, their exams, topics and sources, and whether an AI tool is set up. A
 * read counts for 5 seconds, so the dialog never lists subjects older than that or older than the last change that
 * saves (`refreshCards`).
 */
export const newCardsQuery = {
  // Under "subjects", so whatever marks the subjects stale (a subject added, renamed or removed) marks the places too.
  queryKey: ["subjects", "new-card-places"],
  queryFn: () => invoke("study.newCardPlaces", {}),
  staleTime: 5_000,
};

/** Reads the places before the dialog asks: as the page that opens it is shown, and as the pointer or focus reaches its button. */
export function readPlacesAhead(client: QueryClient, staleTime?: number): void {
  readAhead(client, newCardsQuery, staleTime);
}

/** Opens the dialog with its places read, so the focus goes to its first field at once (`whenRead`). */
export function whenPlacesRead(client: QueryClient, open: () => void): void {
  whenRead(client, newCardsQuery, open);
}
