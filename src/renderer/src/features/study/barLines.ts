// The line under the title in the study bar: what the student is doing and where they are in it. One builder per kind
// of page, taking the translation function so a unit test checks every case.

export type BarT = (key: string, values?: Record<string, unknown>) => string;

/** The pieces of a line, joined with a middle dot; a piece that is not there is left out. */
export function barLine(pieces: ReadonlyArray<string | null | undefined | false>): string {
  return pieces.filter(Boolean).join(" \u00b7 ");
}

/**
 * The quiz's line. On the questions of a diagnostic or a Ripasso, which are saved as the student answers, it says the
 * answers are kept, after the place in a Ripasso that holds cards too; on any other quiz it says which question this is
 * and whether the time is limited.
 */
export function quizLine(
  t: BarT,
  input: {
    stage: "intro" | "questions" | "results";
    /** A diagnostic or a Ripasso: its answers are saved as they are given. */
    kept: boolean;
    /** The exam's title, on the intro. */
    exam?: string;
    position: { current: number; total: number } | null;
    /** A Ripasso that holds flashcards and questions: the place counted over both. */
    overall?: { current: number; total: number };
    /** The time limit in minutes, or null for a quiz without one. */
    timerMinutes: number | null;
  },
): string {
  if (input.stage === "results") return barLine([t("quiz.title"), t("results.title")]);
  // The intro's own headline names the topic or the test, so the bar says only what kind of page this is.
  if (input.stage === "intro") return input.exam ?? "";
  if (input.kept) return barLine([input.overall ? t("cards.reviewPosition", input.overall) : null, t("quiz.keptLine")]);
  return barLine([
    t("quiz.title"),
    [
      input.position ? t("quiz.barPosition", input.position) : null,
      input.timerMinutes ? t("quiz.sheet.minutes", { count: input.timerMinutes }) : t("quiz.sheet.untimed"),
    ]
      .filter(Boolean)
      .join(", "),
  ]);
}

/** Where a set of exercises comes from: only the book, only Pyxis, or both. Null for none. */
export function exerciseMix(exercises: ReadonlyArray<{ generated: boolean }>): "book" | "ai" | "mixed" | null {
  if (exercises.length === 0) return null;
  const written = exercises.filter((exercise) => exercise.generated).length;
  return written === 0 ? "book" : written === exercises.length ? "ai" : "mixed";
}

/** The exercises' line: how many there are and where they come from. */
export function practiceLine(t: BarT, exercises: ReadonlyArray<{ generated: boolean }>): string {
  const mix = exerciseMix(exercises);
  return barLine([
    t("places.practice"),
    mix
      ? [
          t("practice.barCount", { count: exercises.length }),
          mix === "mixed" ? null : t(mix === "book" ? "practice.barBook" : "practice.barAi"),
        ]
          .filter(Boolean)
          .join(", ")
      : null,
  ]);
}

/**
 * The flashcards' line: "Flashcard", the exam or subject of the card on show when the session mixes several (today's
 * cards), then which card of the session this is.
 */
export function cardsLine(t: BarT, input: { place?: string; at: number; total: number }): string {
  return barLine([t("cards.title"), input.place, input.total > 0 ? t("cards.sessionProgress", { done: input.at, total: input.total }) : null]);
}
