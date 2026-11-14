import { createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { allCardsRedirect } from "./redirects";

const open = () =>
  createMemoryRouter(
    [
      { path: "/plans/:planId", element: null },
      { path: "/exams/cards", loader: allCardsRedirect, element: null },
      { path: "/flashcards/all", element: null },
    ],
    { initialEntries: ["/plans/p1"] },
  );

describe("allCardsRedirect", () => {
  it("leads the old address to /flashcards/all with its search", async () => {
    const router = open();
    await router.navigate("/exams/cards?exam=p1");
    expect(router.state.location.pathname).toBe("/flashcards/all");
    expect(router.state.location.search).toBe("?exam=p1");
    router.dispose();
  });

  it("adds one history entry, so Back returns to the page the push came from", async () => {
    const router = open();
    await router.navigate("/exams/cards?exam=p1");
    expect(router.state.historyAction).toBe("PUSH");
    await router.navigate(-1);
    expect(router.state.location.pathname).toBe("/plans/p1");
    router.dispose();
  });

  it("leads the old address without a search to the list with none", async () => {
    const router = open();
    await router.navigate("/exams/cards");
    expect(router.state.location.pathname + router.state.location.search).toBe("/flashcards/all");
    router.dispose();
  });
});
