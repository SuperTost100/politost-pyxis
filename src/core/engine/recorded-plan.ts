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
    const schema = input.responseSchema?.schema as
      { properties?: Record<string, unknown> } | undefined;
    const key =
      input.system?.startsWith("Create distinct") && replies.quizQuestions
        ? "quizQuestions"
        : (Object.keys(schema?.properties ?? {})[0] ?? "markdown");
    const context = JSON.parse(input.prompt) as {
      passages?: Array<{ id: string }>;
      sources?: Array<{ sourceId: string; section: string }>;
      previousQuestions?: string[];
    };
    const text = JSON.stringify(replies[key])
      .replaceAll(
        '"{{allPassages}}"',
        JSON.stringify(context.passages?.map((p) => p.id) ?? []),
      )
      .replaceAll(
        '"{{mapTitle}}"',
        JSON.stringify((context as { title?: string }).title ?? "Map"),
      )
      .replace(
        /\{\{(passage|source|section|question):(\d+)\}\}/g,
        (_, kind: string, raw: string) => {
          const i = Number(raw);
          return kind === "question"
            ? String((context.previousQuestions?.length ?? 0) + i)
            : kind === "passage"
              ? (context.passages?.[i]?.id ?? "missing")
              : kind === "source"
                ? (context.sources?.[i]?.sourceId ?? "missing")
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
