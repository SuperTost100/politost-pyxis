import { describe, expect, it } from "vitest";
import tiers from "../../../../resources/model-tiers.json";
import { roleExceptions, roleItems, roleModelName, rolesOfModel, sentenceTasks } from "./toolRoles";

describe("a tool's roles in its row", () => {
  it("lists the three roles in order with the names a person knows", () => {
    const names: Record<string, string> = {
      "claude-haiku-5-5": "Claude Haiku 5.5",
      "claude-sonnet-5-5": "Claude Sonnet 5.5",
      "claude-opus-5-5": "Claude Opus 5.5",
    };
    expect(
      roleItems(
        { fast: "claude-haiku-5-5", mid: "claude-sonnet-5-5", strong: "claude-opus-5-5" },
        (id) => names[id] ?? id,
      ),
    ).toEqual([
      { role: "fast", model: "Haiku 5.5" },
      { role: "mid", model: "Sonnet 5.5" },
      { role: "strong", model: "Opus 5.5" },
    ]);
  });

  it("keeps the family in the names of the other makers and repeats a model that fills several roles", () => {
    expect(roleModelName("GPT-6.1 Terra")).toBe("GPT-6.1 Terra");
    // The tool spells some GPT names with a hyphen and some with a space; the row spells them all one way.
    expect(roleModelName("GPT-6-Luna")).toBe("GPT-6 Luna");
    expect(roleModelName("GPT-6.1-Sol")).toBe("GPT-6.1 Sol");
    expect(roleModelName("GPT-5.6-Terra")).toBe("GPT-5.6 Terra");
    expect(roleModelName("GPT-OSS 120B (Medium)")).toBe("GPT-OSS 120B (Medium)");
    expect(roleModelName("Gemini 4 Argon")).toBe("Gemini 4 Argon");
    expect(roleModelName("Claude")).toBe("Claude");
    expect(roleItems({ fast: "g", mid: "g", strong: "g" }, () => "Gemini 4 Argon").map((item) => item.model)).toEqual([
      "Gemini 4 Argon",
      "Gemini 4 Argon",
      "Gemini 4 Argon",
    ]);
  });

  it("leaves out a role that has no model", () => {
    expect(roleItems({ fast: null, mid: "m", strong: null }, () => "GPT-6.1 Terra")).toEqual([
      { role: "mid", model: "GPT-6.1 Terra" },
    ]);
    expect(roleItems({ fast: null, mid: null, strong: null }, (id) => id)).toEqual([]);
  });

  it("says which roles a model fills, and nothing for one that fills all three", () => {
    const models = { fast: "a", mid: "b", strong: "b" };
    expect(rolesOfModel(models, "a")).toEqual(["fast"]);
    expect(rolesOfModel(models, "b")).toEqual(["mid", "strong"]);
    expect(rolesOfModel({ fast: "g", mid: "g", strong: "g" }, "g")).toEqual([]);
    expect(rolesOfModel(models, "c")).toEqual([]);
  });

  it("finds the tasks a tool runs in another role than the sentence under the list says", () => {
    expect(roleExceptions({ chat: "fast", cards: "fast", map: "fast", lesson: "mid", grading: "mid", plan: "strong" })).toEqual([]);
    expect(roleExceptions({ chat: "mid", map: "fast", plan: "strong" })).toEqual([{ feature: "chat", role: "mid" }]);
  });

  it("names in the sentence the tasks that model-tiers.json puts in each role", () => {
    const features = tiers.features as Record<string, { tier: string }>;
    for (const [role, tasks] of Object.entries(sentenceTasks))
      for (const task of tasks) expect(features[task]?.tier).toBe(role);
    // Every task the sentence leaves out (the default tool and photos) runs in the mid role, as the sentence implies.
    const named = new Set(Object.values(sentenceTasks).flat());
    for (const [task, value] of Object.entries(features)) if (!named.has(task)) expect(value.tier).toBe("mid");
  });
});
