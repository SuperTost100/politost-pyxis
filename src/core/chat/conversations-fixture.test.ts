import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Conversation = {
  id: string;
  language: string;
  history: Array<{ role: string; text: string }>;
  message: string;
  rule: string;
  [key: string]: unknown;
};

const file = JSON.parse(readFileSync("tests/fixtures/chat-conversations.json", "utf8")) as { conversations: Conversation[] };

describe("the conversations a chat reply is judged on", () => {
  it("are at least ten, in both languages, each with a rule and no tool answer", () => {
    const { conversations } = file;
    expect(conversations.length).toBeGreaterThanOrEqual(10);
    expect(new Set(conversations.map((conv) => conv.id)).size).toBe(conversations.length);
    expect(new Set(conversations.map((conv) => conv.language))).toEqual(new Set(["it", "en"]));
    for (const conv of conversations) {
      expect(conv.message.trim(), conv.id).not.toBe("");
      expect(conv.rule.trim(), conv.id).not.toBe("");
      // The history alternates, starts with the student and ends with the tutor, so the last message answers it.
      conv.history.forEach((turn, index) => expect(turn.role, conv.id).toBe(index % 2 === 0 ? "user" : "assistant"));
      if (conv.history.length) expect(conv.history.at(-1)!.role, conv.id).toBe("assistant");
      expect(Object.keys(conv), conv.id).not.toContain("reply");
      for (const key of ["must", "mustNot", "mustFormula", "mustNotFormula"])
        for (const pattern of (conv[key] as string[] | undefined) ?? []) expect(() => new RegExp(pattern), `${conv.id} ${key}`).not.toThrow();
    }
  });

  it("cover the cases the chat's one way of answering has to tell apart", () => {
    const ids = file.conversations.map((conv) => conv.id);
    for (const id of [
      "solve-exercise",
      "explain-topic",
      "attempt-wrong-step",
      "stuck",
      "hint",
      "guide-then-solution",
      "guide-to-the-end",
      "check-right",
      "check-wrong",
      "mixed",
      "not-study",
    ])
      expect(ids).toContain(id);
  });
});
