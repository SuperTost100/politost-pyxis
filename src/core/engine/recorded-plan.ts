import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { GenerateInput } from "./generate";

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
    // A quiz is written a few questions per call: each call gets the first `count` recorded questions, numbered after
    // the ones already written.
    const recorded = replies[key] as { questions?: unknown[] } | undefined;
    const reply =
      key === "quizQuestions" &&
      context.count != null &&
      Array.isArray(recorded?.questions) &&
      recorded.questions.length > context.count
        ? { ...recorded, questions: recorded.questions.slice(0, context.count) }
        : recorded;
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
            ? String((context.previousQuestions?.length ?? 0) + i)
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
