import { describe, expect, it } from "vitest";
import { planAuto, pickModel, type AutoProvider } from "./auto";

const all = [
  { id: "low" },
  { id: "medium" },
  { id: "high" },
  { id: "xhigh" },
  { id: "max" },
];
const model = (id: string, efforts = all) => ({ id, efforts });

const claude: AutoProvider = {
  id: "claude",
  kind: "cli",
  effort: true,
  models: [
    model("claude-fable-5-1"),
    model("claude-opus-5-5"),
    model("claude-sonnet-5"),
    model("claude-haiku-4-5-20251001", []),
  ],
};
const codex: AutoProvider = {
  id: "codex",
  kind: "cli",
  effort: true,
  models: [
    model("gpt-6-astra"),
    model("gpt-6-sol"),
    model("gpt-6-luna"),
    model("gpt-5.6-sol"),
    model("gpt-5.6-terra"),
    model("gpt-5.6-luna"),
    model("gpt-5.5"),
  ],
};
const anthropicApi: AutoProvider = {
  id: "anthropic-api",
  kind: "api",
  effort: false,
  models: [
    model("claude-sonnet-4-5-20250929", []),
    model("claude-opus-4-1-20250805", []),
    model("claude-haiku-4-5-20251001", []),
  ],
};
const openaiApi: AutoProvider = {
  id: "openai-api",
  kind: "api",
  effort: false,
  models: [
    model("gpt-4o", []),
    model("gpt-5", []),
    model("gpt-5-mini", []),
    model("gpt-5-mini-2025-08-07", []),
    model("gpt-5-nano", []),
    model("gpt-5.1", []),
  ],
};

function summary(plan: ReturnType<typeof planAuto>) {
  return Object.fromEntries(
    Object.entries(plan).map(([feature, choice]) => [
      feature,
      `${choice.provider}:${choice.model}${choice.effort ? `:${choice.effort}` : ""}`,
    ]),
  );
}

describe("automatic engine policy", () => {
  it("splits work between Claude Code and Codex by tier and keeps the load even", () => {
    expect(summary(planAuto([claude, codex]))).toEqual({
      chat: "codex:gpt-6-luna:low",
      map: "codex:gpt-6-luna:low",
      grading: "codex:gpt-6-sol:high",
      lesson: "claude:claude-sonnet-5:medium",
      vision: "claude:claude-sonnet-5:medium",
      default: "claude:claude-sonnet-5:medium",
      plan: "claude:claude-opus-5-5:high",
    });
  });

  it("does not depend on the order the providers are listed in", () => {
    expect(summary(planAuto([codex, claude]))).toEqual(
      summary(planAuto([claude, codex])),
    );
  });

  it("puts everything on Claude Code by tier when it is the only engine", () => {
    expect(summary(planAuto([claude]))).toEqual({
      chat: "claude:claude-haiku-4-5-20251001",
      map: "claude:claude-haiku-4-5-20251001",
      lesson: "claude:claude-sonnet-5:medium",
      vision: "claude:claude-sonnet-5:medium",
      default: "claude:claude-sonnet-5:medium",
      grading: "claude:claude-opus-5-5:high",
      plan: "claude:claude-opus-5-5:high",
    });
  });

  it("puts everything on Codex by tier when it is the only engine", () => {
    expect(summary(planAuto([codex]))).toEqual({
      chat: "codex:gpt-6-luna:low",
      map: "codex:gpt-6-luna:low",
      lesson: "codex:gpt-5.6-terra:medium",
      // gpt-6-luna is not a known image model, so photos use the newest model that is.
      vision: "codex:gpt-5.6-terra:medium",
      default: "codex:gpt-5.6-terra:medium",
      grading: "codex:gpt-6-sol:high",
      plan: "codex:gpt-6-sol:high",
    });
  });

  it("uses API providers only when no CLI is ready, without effort", () => {
    expect(summary(planAuto([anthropicApi, openaiApi, claude]))).toEqual(
      summary(planAuto([claude])),
    );
    const plan = summary(planAuto([anthropicApi]));
    expect(plan.chat).toBe("anthropic-api:claude-haiku-4-5-20251001");
    expect(plan.lesson).toBe("anthropic-api:claude-sonnet-4-5-20250929");
    expect(plan.plan).toBe("anthropic-api:claude-opus-4-1-20250805");
    const both = summary(planAuto([anthropicApi, openaiApi]));
    expect(
      Object.values(both).every((value) => !/:(low|high)$/.test(value)),
    ).toBe(true);
    expect(new Set(Object.values(both).map((v) => v.split(":")[0]))).toEqual(
      new Set(["anthropic-api", "openai-api"]),
    );
  });

  it("returns nothing when no engine is ready", () => {
    expect(planAuto([])).toEqual({});
    expect(planAuto([{ ...claude, models: [] }])).toEqual({});
  });

  it("steps to a neighbouring tier, then to the first listed model", () => {
    const noHaiku: AutoProvider = {
      ...claude,
      models: claude.models.filter((m) => !m.id.includes("haiku")),
    };
    expect(pickModel(noHaiku, "fast")?.id).toBe("claude-sonnet-5");
    const onlyOpus: AutoProvider = {
      ...claude,
      models: [model("claude-opus-5-5")],
    };
    expect(pickModel(onlyOpus, "mid")?.id).toBe("claude-opus-5-5");
    const unknown: AutoProvider = {
      ...codex,
      models: [model("mystery-1"), model("mystery-2")],
    };
    expect(pickModel(unknown, "strong")?.id).toBe("mystery-1");
  });

  it("takes the newest model of a tier and uses Fable only after Opus", () => {
    const fableOnly: AutoProvider = {
      ...claude,
      models: [model("claude-sonnet-5"), model("claude-fable-5-1")],
    };
    expect(pickModel(fableOnly, "strong")?.id).toBe("claude-fable-5-1");
    expect(pickModel(claude, "strong")?.id).toBe("claude-opus-5-5");
    const twoOpus: AutoProvider = {
      ...claude,
      models: [model("claude-opus-5"), model("claude-opus-5-5")],
    };
    expect(pickModel(twoOpus, "strong")?.id).toBe("claude-opus-5-5");
  });

  it("keeps photos on a model that reads images", () => {
    const textOnlyClaude: AutoProvider = {
      ...claude,
      models: [model("text-only-mini"), model("claude-sonnet-5")],
    };
    expect(planAuto([textOnlyClaude]).vision?.model).toBe("claude-sonnet-5");
  });

  it("omits effort for models that do not list it", () => {
    const plan = planAuto([{ ...claude, effort: false }]);
    expect(plan.plan).toEqual({ provider: "claude", model: "claude-opus-5-5" });
  });

  it("plans only the requested features", () => {
    expect(Object.keys(planAuto([claude], ["chat"]))).toEqual(["chat"]);
  });
});
