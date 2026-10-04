import { z } from "zod";

const finiteDays = z.number().finite().nonnegative().max(365000);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.number().int().nonnegative().max(8640000000000000);
const isoDate = z
  .string()
  .max(40)
  .refine((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  }, "Invalid scheduler date");

export const cardRatingSchema = z.enum(["again", "hard", "good", "easy"]);
export const cardScheduleSchema = z
  .object({
    intervalDays: finiteDays.int(),
    ease: z.number().finite().min(0).max(10),
    dueAt: timestamp,
    fsrs: z
      .object({
        due: isoDate,
        stability: finiteDays,
        difficulty: z.number().finite().min(0).max(10),
        elapsed_days: finiteDays.int(),
        scheduled_days: finiteDays.int(),
        learning_steps: count,
        reps: count,
        lapses: count,
        state: z.number().int().min(0).max(3),
        last_review: isoDate.optional(),
      })
      .optional(),
  })
  .superRefine((state, context) => {
    if (!state.fsrs) return;
    if (
      Date.parse(state.fsrs.due) !== state.dueAt ||
      state.fsrs.scheduled_days !== state.intervalDays
    )
      context.addIssue({
        code: "custom",
        message: "Inconsistent scheduler state",
      });
    if (state.fsrs.lapses > state.fsrs.reps)
      context.addIssue({ code: "custom", message: "Invalid review counts" });
  });

export const cardReviewSchema = z.object({
  rating: cardRatingSchema,
  state: cardScheduleSchema,
  at: timestamp,
});
