/**
 * Whether the Review page offers a flashcard count, and whether it says that no flashcard is due. `due` is the plan's
 * due cards, undefined while the count loads or when it failed: then the choice stays, since Start takes cards anyway.
 */
export function cardOffer(due: number | undefined): { choice: boolean; noneDue: boolean } {
  return { choice: due !== 0, noneDue: due === 0 };
}
