import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { GenerateInput } from "./generate";

/** A pattern per recorded question's stem, with its `{{…}}` placeholders matching whatever they were filled with. */
function recordedStems(questions: unknown[]): RegExp[] {
  return questions.flatMap((question) => {
    const stem = (question as { stem?: unknown } | null)?.stem;
    if (typeof stem !== "string") return [];
    const parts = stem.split(/\{\{[^}]*\}\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return [new RegExp(`^${parts.join(".*?")}$`, "s")];
  });
}

/** Unpackaged integration fixture only; the caller must enforce the dev flag. */
export function recordedPlanRun(
  fixture: string,
  delayMs = 0,
): NonNullable<GenerateInput["run"]> {
  const replies = JSON.parse(fixture) as Record<string, unknown>;
  return async (input) => {
    await delay(Math.min(Math.max(delayMs, 0), 10000), undefined, {
      signal: input.signal,
    });
    if (!input.responseSchema) {
      const markdown = replies.markdown as
        | { markdown?: string; streamed?: string; hold?: string }
        | undefined;
      // A streamed lesson can show a first part, then wait for the test to create the hold file before it ends.
      if (input.onDelta && markdown?.streamed) {
        input.onDelta(markdown.streamed);
        while (markdown.hold && !existsSync(markdown.hold))
          await delay(50, undefined, { signal: input.signal });
      }
      return {
        text: markdown?.markdown ?? "Recorded lesson [P1].",
        model: "recorded-plan",
        provider: "fixture",
        inputTokens: 0,
      };
    }
    const schema = input.responseSchema?.schema as
      { properties?: Record<string, unknown> } | undefined;
    // A past paper's reply is the whole object, so it cannot be told apart by its first property.
    const key =
      input.system?.startsWith("Create distinct") && replies.quizQuestions
        ? "quizQuestions"
        : input.system?.startsWith("Read one past written exam") && replies.paper
          ? "paper"
          : (Object.keys(schema?.properties ?? {})[0] ?? "markdown");
    const context = JSON.parse(input.prompt) as {
      passages?: Array<{ id: string }>;
      sources?: Array<{ sourceId: string; section: string; segmentId?: string }>;
      previousQuestions?: string[];
      count?: number;
    };
    // A quiz is written a few questions per call: each call gets the next `count` recorded questions, after the ones
    // already written. A recording too short for that hands every call its first `count` instead.
    const recorded = replies[key] as { questions?: unknown[] } | undefined;
    const previous = context.previousQuestions ?? [];
    const written = previous.length;
    const batch =
      key === "quizQuestions" &&
      context.count != null &&
      Array.isArray(recorded?.questions) &&
      recorded.questions.length > context.count
        ? context.count
        : undefined;
    // Only questions earlier calls took from the recording move it on; a quiz can start with the topic's book
    // exercises, which are not recorded.
    const generated =
      batch != null ? previous.filter((stem) => recordedStems(recorded!.questions!).some((re) => re.test(stem))).length : 0;
    const from =
      batch != null && recorded!.questions!.length >= generated + batch ? generated : 0;
    const reply =
      batch != null ? { ...recorded, questions: recorded!.questions!.slice(from, from + batch) } : recorded;
    // `{{question:N}}` names a recorded question's place in the whole quiz.
    const questionShift = written - from;
    const text = JSON.stringify(reply)
      .replaceAll(
        '"{{allPassages}}"',
        JSON.stringify(context.passages?.map((p) => p.id) ?? []),
      )
      .replaceAll(
        '"{{mapTitle}}"',
        JSON.stringify((context as { title?: string }).title ?? "Map"),
      )
      .replace(
        /\{\{(passage|source|section|segment|question):(\d+)\}\}/g,
        (_, kind: string, raw: string) => {
          const i = Number(raw);
          return kind === "question"
            ? String(questionShift + i)
            : kind === "passage"
              ? (context.passages?.[i]?.id ?? "missing")
              : kind === "source"
                ? (context.sources?.[i]?.sourceId ?? "missing")
                : kind === "segment"
                  ? (context.sources?.[i]?.segmentId ?? "missing")
                  : (context.sources?.[i]?.section ?? "missing");
        },
      );
    return {
      text,
      structured: JSON.parse(text),
      model: "recorded-plan",
      provider: "fixture",
      inputTokens: 0,
    };
  };
}
