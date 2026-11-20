import { afterEach, describe, expect, it } from "vitest";
import { adoptModelFile, modelFile, resetModelFile, type ModelFile } from "./model-roles";
import { planAuto, pickModel, rolesOf, taskRolesOf, type AutoProvider } from "./auto";

const all = [
  { id: "low" },
  { id: "medium" },
  { id: "high" },
  { id: "xhigh" },
  { id: "max" },
];
const model = (id: string, efforts = all) => ({ id, efforts });

// What the tools report on a signed-in machine (cli-funnel 0.9), newest first as they come.
const claude: AutoProvider = {
  id: "claude",
  kind: "cli",
  effort: true,
  models: [
    model("claude-fable-5-2"),
    model("claude-fable-5-1"),
    model("claude-opus-5-5"),
    model("claude-sonnet-5-5"),
    model("claude-sonnet-5"),
    model("claude-opus-4-6"),
    model("claude-haiku-5-5"),
    model("claude-haiku-4-5-20251001", []),
  ],
};
const codex: AutoProvider = {
  id: "codex",
  kind: "cli",
  effort: true,
  models: [
    model("gpt-6.2-sol"),
    model("gpt-6.2-astra"),
    model("gpt-6.1-terra"),
    model("gpt-6.1-sol"),
    model("gpt-6-astra"),
    model("gpt-6-sol"),
    model("gpt-6-luna"),
    model("gpt-5.6-sol"),
    model("gpt-5.6-terra"),
    model("gpt-5.6-luna"),
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
      // The model file runs the chat on the mid role of Claude and ChatGPT, whichever of them gets it.
      chat: "codex:gpt-6.1-terra:medium",
      map: "codex:gpt-6-luna:low",
      cards: "codex:gpt-6-luna:low",
      grading: "codex:gpt-6.1-terra:medium",
      lesson: "claude:claude-sonnet-5-5:medium",
      vision: "claude:claude-sonnet-5-5:medium",
      default: "claude:claude-sonnet-5-5:medium",
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
      chat: "claude:claude-sonnet-5-5:medium",
      map: "claude:claude-haiku-5-5:low",
      cards: "claude:claude-haiku-5-5:low",
      lesson: "claude:claude-sonnet-5-5:medium",
      vision: "claude:claude-sonnet-5-5:medium",
      default: "claude:claude-sonnet-5-5:medium",
      grading: "claude:claude-sonnet-5-5:medium",
      plan: "claude:claude-opus-5-5:high",
    });
  });

  it("takes the first id of the role that the tool reports, whatever order the tool lists its models in", () => {
    const shuffled: AutoProvider = { ...claude, models: [...claude.models].reverse() };
    expect(summary(planAuto([shuffled]))).toEqual(summary(planAuto([claude])));
    // The file's order wins: Sonnet 5.5 is listed before Sonnet 5, so Sonnet 5 is used only when 5.5 is not reported.
    const olderSonnet: AutoProvider = {
      ...claude,
      models: claude.models.filter((m) => m.id !== "claude-sonnet-5-5"),
    };
    expect(pickModel(olderSonnet, "mid")?.id).toBe("claude-sonnet-5");
    const dated: AutoProvider = {
      id: "anthropic-api",
      kind: "api",
      effort: false,
      models: [model("claude-sonnet-4-5-20250929", []), model("claude-opus-4-1-20250805", [])],
    };
    expect(pickModel(dated, "mid")?.id).toBe("claude-sonnet-4-5-20250929");
  });

  it("puts everything on Codex by tier when it is the only engine", () => {
    expect(summary(planAuto([codex]))).toEqual({
      chat: "codex:gpt-6.1-terra:medium",
      map: "codex:gpt-6-luna:low",
      cards: "codex:gpt-6-luna:low",
      lesson: "codex:gpt-6.1-terra:medium",
      // Photos take the first model of the mid list that reads images: the newest one.
      vision: "codex:gpt-6.1-terra:medium",
      default: "codex:gpt-6.1-terra:medium",
      grading: "codex:gpt-6.1-terra:medium",
      plan: "codex:gpt-6.2-sol:high",
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

  it("steps to a neighbouring role, then to the maker's first own model, never to another company's", () => {
    const noHaiku: AutoProvider = {
      ...claude,
      models: claude.models.filter((m) => !m.id.includes("haiku")),
    };
    expect(pickModel(noHaiku, "fast")?.id).toBe("claude-sonnet-5-5");
    const onlyOpus: AutoProvider = {
      ...claude,
      models: [model("claude-opus-5-5")],
    };
    expect(pickModel(onlyOpus, "mid")?.id).toBe("claude-opus-5-5");
    // None of the file's ids is reported: the first of the maker's own models is used.
    const unlisted: AutoProvider = {
      ...codex,
      models: [model("gpt-7-nova"), model("gpt-7-vega"), model("claude-opus-5-5")],
    };
    expect(pickModel(unlisted, "strong")?.id).toBe("gpt-7-nova");
    // Nothing of its own is reported: the tool has no model to give, and planAuto leaves it out.
    const foreign: AutoProvider = { ...codex, models: [model("claude-opus-5-5"), model("gemini-3.8-flash")] };
    expect(pickModel(foreign, "strong")).toBeUndefined();
    expect(planAuto([foreign])).toEqual({});
  });

  it("never picks Fable, even when it is the only model the account reports", () => {
    const fableOnly: AutoProvider = {
      ...claude,
      models: [model("claude-sonnet-5"), model("claude-fable-5-1")],
    };
    expect(pickModel(fableOnly, "strong")?.id).toBe("claude-sonnet-5");
    expect(pickModel(claude, "strong")?.id).toBe("claude-opus-5-5");
    const onlyFable: AutoProvider = { ...claude, models: [model("claude-fable-5-2")] };
    expect(planAuto([onlyFable])).toEqual({});
  });

  it("takes the newest model that reads images for photos", () => {
    // The mid list names gpt-6.1-terra first, and the model file says it reads images, so photos use it.
    expect(planAuto([codex]).vision?.model).toBe("gpt-6.1-terra");
    // A model the file says nothing about is not one that reads images, whatever its name.
    const unknownNewest: AutoProvider = {
      ...codex,
      models: [model("gpt-7-nova"), model("gpt-6.1-terra"), model("gpt-6-luna")],
    };
    expect(planAuto([unknownNewest]).vision?.model).toBe("gpt-6.1-terra");
    // With no model that reads images at all, the photo task still gets the tool's first model.
    expect(planAuto([{ ...codex, models: [model("gpt-7-nova")] }]).vision?.model).toBe("gpt-7-nova");
  });

  it("never plans photos on a provider that refuses images, whatever its model ids say", () => {
    // Antigravity lists Claude and GPT models that match the catalog, but its CLI cannot take a picture.
    expect(antigravity.images).toBe(false);
    // Only the provider that takes images gets the photo feature.
    expect(planAuto([antigravity, claude]).vision?.provider).toBe("claude");
    expect(planAuto([antigravity, codex]).vision?.provider).toBe("codex");
  });

  it("omits effort for models that do not list it", () => {
    const plan = planAuto([{ ...claude, effort: false }]);
    expect(plan.plan).toEqual({ provider: "claude", model: "claude-opus-5-5" });
  });

  it("plans only the requested features", () => {
    expect(Object.keys(planAuto([claude], ["chat"]))).toEqual(["chat"]);
  });
});

// Antigravity as `agy models` reports it: a mix of makers, of which only the Gemini models may be used.
const antigravity: AutoProvider = {
  id: "antigravity",
  kind: "cli",
  effort: true,
  images: false,
  models: [
    model("gemini-4-neon", all.slice(0, 3)),
    model("gemini-4-neon-xhigh", []),
    model("gemini-4-argon", all.slice(0, 3)),
    model("gemini-4-hydrogen", all.slice(0, 3)),
    model("gemini-pro-orchestrator-neon", []),
    model("gemini-3.8-flash", all.slice(0, 3)),
    model("claude-opus-5-5", all.slice(0, 3)),
    model("claude-sonnet-5-5", all.slice(0, 3)),
    model("gpt-oss-120b-medium", []),
  ],
};

/** provider/model per feature, in the order default chat plan lesson grading map vision cards. */
const combinations: Record<string, string> = {
  antigravity:
    "antigravity/gemini-4-hydrogen antigravity/gemini-4-hydrogen antigravity/gemini-4-argon antigravity/gemini-4-hydrogen antigravity/gemini-4-hydrogen antigravity/gemini-4-hydrogen antigravity/gemini-4-hydrogen antigravity/gemini-4-hydrogen",
  "claude+antigravity":
    "claude/claude-sonnet-5-5 antigravity/gemini-4-hydrogen claude/claude-opus-5-5 claude/claude-sonnet-5-5 antigravity/gemini-4-hydrogen antigravity/gemini-4-hydrogen claude/claude-sonnet-5-5 antigravity/gemini-4-hydrogen",
  "codex+antigravity":
    "codex/gpt-6.1-terra antigravity/gemini-4-hydrogen codex/gpt-6.2-sol codex/gpt-6.1-terra antigravity/gemini-4-hydrogen antigravity/gemini-4-hydrogen codex/gpt-6.1-terra antigravity/gemini-4-hydrogen",
  "claude+codex+antigravity":
    "claude/claude-sonnet-5-5 antigravity/gemini-4-hydrogen codex/gpt-6.2-sol codex/gpt-6.1-terra claude/claude-sonnet-5-5 antigravity/gemini-4-hydrogen claude/claude-sonnet-5-5 antigravity/gemini-4-hydrogen",
};
const order = [
  "default",
  "chat",
  "plan",
  "lesson",
  "grading",
  "map",
  "vision",
  "cards",
] as const;
const makers: Record<string, RegExp> = {
  claude: /^claude-/,
  codex: /^gpt-/,
  antigravity: /^gemini-/,
};
const byId: Record<string, AutoProvider> = {
  claude,
  codex,
  antigravity,
};

describe("automatic choice with Antigravity", () => {
  it.each(Object.entries(combinations))(
    "gives %s a balanced default",
    (combo, expected) => {
      const plan = planAuto(combo.split("+").map((id) => byId[id]!));
      expect(
        order.map((f) => `${plan[f]?.provider}/${plan[f]?.model}`).join(" "),
      ).toBe(expected);
    },
  );

  it("covers every mix of the three CLIs, using each engine and only its maker's models", () => {
    const ids = ["claude", "codex", "antigravity"];
    for (let mask = 1; mask < 8; mask++) {
      const ready = ids
        .filter((_, i) => mask & (1 << i))
        .map((id) => byId[id]!);
      const plan = planAuto(ready);
      const used = new Set(
        Object.values(plan).map((choice) => choice!.provider),
      );
      expect(Object.keys(plan).sort()).toEqual([...order].sort());
      expect(used.size).toBe(ready.length);
      for (const choice of Object.values(plan)) {
        expect(choice!.model).not.toMatch(/thinking|fable/);
        expect(choice!.model).toMatch(makers[choice!.provider]!);
      }
    }
  });
});

describe("the order the student put their tools in", () => {
  const providersOf = (plan: ReturnType<typeof planAuto>) =>
    Object.fromEntries(Object.entries(plan).map(([feature, choice]) => [feature, choice.provider]));

  it("gives every task to the first tool of the list, each on the model of its role", () => {
    expect(summary(planAuto([claude, codex], undefined, ["codex", "claude"]))).toEqual({
      chat: "codex:gpt-6.1-terra:medium",
      map: "codex:gpt-6-luna:low",
      cards: "codex:gpt-6-luna:low",
      grading: "codex:gpt-6.1-terra:medium",
      lesson: "codex:gpt-6.1-terra:medium",
      vision: "codex:gpt-6.1-terra:medium",
      default: "codex:gpt-6.1-terra:medium",
      plan: "codex:gpt-6.2-sol:high",
    });
    expect(new Set(Object.values(providersOf(planAuto([claude, codex], undefined, ["claude", "codex"]))))).toEqual(
      new Set(["claude"]),
    );
  });

  it("follows the list, not the order the ready tools came in", () => {
    expect(planAuto([codex, claude], undefined, ["claude", "codex"])).toEqual(
      planAuto([claude, codex], undefined, ["claude", "codex"]),
    );
  });

  it("hands a task the first tool cannot do to the next one that can", () => {
    // Gemini reads no pictures, so photos go to the second tool and the rest stays on the first.
    const plan = providersOf(planAuto([antigravity, claude], undefined, ["antigravity", "claude"]));
    expect(plan.vision).toBe("claude");
    expect(new Set(Object.entries(plan).filter(([feature]) => feature !== "vision").map(([, id]) => id))).toEqual(
      new Set(["antigravity"]),
    );
  });

  it("uses a tool the list leaves out only after the listed ones", () => {
    const plan = providersOf(planAuto([claude, codex, antigravity], undefined, ["antigravity"]));
    // Claude came before ChatGPT among the ready tools, so it is the second choice, for the photos Gemini cannot read.
    expect(plan.vision).toBe("claude");
    expect(plan.chat).toBe("antigravity");
  });

  it("skips a listed tool that is not ready", () => {
    expect(
      new Set(Object.values(providersOf(planAuto([codex], undefined, ["claude", "codex"])))),
    ).toEqual(new Set(["codex"]));
  });

  it("shares the work as before with no list, and for a pool the list does not name", () => {
    expect(planAuto([claude, codex], undefined, null)).toEqual(planAuto([claude, codex]));
    // Only API keys are ready: the list names subscriptions, so it does not apply.
    expect(planAuto([anthropicApi, openaiApi], undefined, ["claude", "codex"])).toEqual(
      planAuto([anthropicApi, openaiApi]),
    );
  });
});

describe("the three roles of a tool, as its row shows them", () => {
  const ids = (provider: AutoProvider) => provider.models.map((m) => m.id);

  it("names the model the automatic choice runs for each role on this account", () => {
    expect(rolesOf("claude", ids(claude))).toEqual({
      fast: "claude-haiku-5-5",
      mid: "claude-sonnet-5-5",
      strong: "claude-opus-5-5",
    });
    expect(rolesOf("codex", ids(codex))).toEqual({
      fast: "gpt-6-luna",
      mid: "gpt-6.1-terra",
      strong: "gpt-6.2-sol",
    });
  });

  it("agrees with what planAuto gives each task, so the row never says one thing and the choice another", () => {
    const plan = planAuto([claude]);
    const roles = rolesOf("claude", ids(claude));
    // The chat runs on Claude's mid role (featureRoles), the other fast tasks on its fast role.
    expect(plan.chat?.model).toBe(roles.mid);
    expect(plan.map?.model).toBe(roles.fast);
    expect(plan.lesson?.model).toBe(roles.mid);
    expect(plan.plan?.model).toBe(roles.strong);
  });

  it("uses the first model of the list the account has, not the first of the list", () => {
    // The newest Sonnet is not on this account: the older one of the same role is.
    const older = ids(claude).filter((id) => id !== "claude-sonnet-5-5");
    expect(rolesOf("claude", older).mid).toBe("claude-sonnet-5");
  });

  it("steps a role none of whose models the account has to the neighbouring role", () => {
    const noHaiku = ids(claude).filter((id) => !id.includes("haiku"));
    expect(rolesOf("claude", noHaiku)).toEqual({
      fast: "claude-sonnet-5-5",
      mid: "claude-sonnet-5-5",
      strong: "claude-opus-5-5",
    });
    // Only the maker's first listed model is left: every role runs on it.
    expect(rolesOf("codex", ["gpt-7-nova", "claude-opus-5-5"])).toEqual({
      fast: "gpt-7-nova",
      mid: "gpt-7-nova",
      strong: "gpt-7-nova",
    });
  });

  it("leaves every role empty for a tool with no model of its own, and never names Fable", () => {
    expect(rolesOf("codex", ["claude-opus-5-5", "gemini-3.8-flash"])).toEqual({ fast: null, mid: null, strong: null });
    expect(rolesOf("claude", ["claude-fable-5-2"])).toEqual({ fast: null, mid: null, strong: null });
    expect(rolesOf("claude", [])).toEqual({ fast: null, mid: null, strong: null });
  });

  it("names the file's preferred model of each role for a tool that is not connected", () => {
    expect(rolesOf("antigravity", null)).toEqual({
      fast: "gemini-4-hydrogen",
      mid: "gemini-4-hydrogen",
      strong: "gemini-4-carbon",
    });
  });

  it("has nothing to say about a tool the file has no rule for", () => {
    expect(rolesOf("ollama", ["gemma3:12b"])).toEqual({ fast: null, mid: null, strong: null });
    expect(rolesOf("ollama", null)).toEqual({ fast: null, mid: null, strong: null });
  });

  describe("the role each task runs in on a tool", () => {
    afterEach(() => resetModelFile());

    it("is the task's tier on a tool the file gives no featureRoles", () => {
      expect(taskRolesOf("antigravity")).toMatchObject({ chat: "fast", map: "fast", cards: "fast", lesson: "mid", grading: "mid", plan: "strong" });
    });

    it("runs the chat on the mid role of Claude and ChatGPT, as the shipped file says, and nothing else", () => {
      for (const tool of ["claude", "codex"]) {
        expect(taskRolesOf(tool)).toMatchObject({ chat: "mid", map: "fast", cards: "fast", lesson: "mid", grading: "mid", plan: "strong" });
      }
    });

    it("follows featureRoles on the tool that has them and only on that tool", () => {
      const file = JSON.parse(JSON.stringify(modelFile())) as ModelFile;
      file.updatedAt = "2099-01-01T00:00:00Z";
      file.tools.antigravity!.featureRoles = { chat: "mid" };
      delete file.tools.claude!.featureRoles;
      expect(adoptModelFile(file)).toBe(true);
      expect(taskRolesOf("antigravity").chat).toBe("mid");
      expect(taskRolesOf("antigravity").map).toBe("fast");
      expect(taskRolesOf("claude").chat).toBe("fast");
    });
  });
});
