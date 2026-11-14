/**
 * How many questions a gap drill asks (LES-03: a short explanation, then these). The core writes that many and the
 * renderer says that many while it does, so this is the one place the number lives. The rule that closes a gap is the
 * other half of the drill and lives in `shouldClose` (`src/core/study/gaps.ts`).
 */
export const GAP_DRILL_QUESTIONS = 5;
