/** A plan the student is preparing, with its topics in order and the topics of the steps already done, oldest first. */
export type StarterPlan = {
  id: string;
  subject: string | null;
  topics: Array<{ id: string; title: string }>;
  studied: string[];
};

export type Starter = {
  kind: "explain" | "quiz" | "exercise";
  topic: string;
  planId: string;
  subject: string | null;
};

/** Plans worth suggesting from: built, and with the exam still ahead or undated. The list comes nearest exam first. */
export function activePlans<T extends { status: string; daysToExam: number | null }>(
  plans: T[],
  max = 2,
): T[] {
  return plans
    .filter((plan) => plan.status === "ready" && (plan.daysToExam === null || plan.daysToExam >= 0))
    .slice(0, max);
}

/**
 * Up to three prompts for an empty chat: explain the next topic of the nearest plan, quiz the topic studied last (or the
 * one after the next), explain the next topic of the second plan, and with one plan only an exercise on its next topic.
 */
export function starterPrompts(plans: StarterPlan[]): Starter[] {
  const out: Starter[] = [];
  const next = (plan: StarterPlan) =>
    plan.topics.find((topic) => !plan.studied.includes(topic.id)) ?? plan.topics[0];
  const [first, second] = plans.filter((plan) => plan.topics.length > 0);
  if (!first) return out;
  const add = (kind: Starter["kind"], plan: StarterPlan, topic?: { title: string }) => {
    if (topic) out.push({ kind, topic: topic.title, planId: plan.id, subject: plan.subject });
  };
  const ahead = next(first);
  add("explain", first, ahead);
  const lastStudied = [...first.studied]
    .reverse()
    .map((id) => first.topics.find((topic) => topic.id === id))
    .find((topic) => topic && topic.id !== ahead?.id);
  const after = first.topics[first.topics.findIndex((topic) => topic.id === ahead?.id) + 1];
  add("quiz", first, lastStudied ?? after);
  if (second) add("explain", second, next(second));
  else add("exercise", first, ahead);
  return out;
}
