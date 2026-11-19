import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { judge, type Conversation as Rules } from "../../../scripts/judge-chat-rules";

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

  describe("the rules, applied to replies", () => {
    const conv = (id: string) => file.conversations.find((item) => item.id === id) as unknown as Rules;
    const ok = (id: string, reply: string) => judge(conv(id), reply, { followups: false }).fails;

    it("see an answer disclosed in a formula next to a word, however it is typeset", () => {
      const attempt = "attempt-wrong-step";
      expect(ok(attempt, "Quasi: il risultato è $x = 4$ quindi hai sbagliato un segno. Cosa ottieni?")).toContain("has x=4\\b");
      expect(ok(attempt, "Quasi: il risultato è x = 4 poi controlla. Cosa ottieni?")).toContain("has x=4\\b");
      expect(ok(attempt, "Il segno del 6 cambia: quanto vale $2x$ dopo aver sottratto 6?")).toEqual([]);
      // The same number inside another one is not the answer.
      expect(ok(attempt, "Prova con x = 40 e vedi se torna. Cosa ottieni?")).toEqual([]);
    });

    it("ask for the minimum as the value of f(2), and not a step number, and reject a step handed back", () => {
      const solution = "guide-then-solution";
      const worked = "1. f'(x) = 2x - 4.\n2. x = 2.\n3. f(2) = 4 - 8 + 7 = 3. Il minimo vale 3.";
      expect(ok(solution, worked)).toEqual([]);
      expect(ok(solution, "1. f'(x) = 2x - 4.\n2. Quindi x = 2.\n3. Verifichiamo che sia un minimo.")).toContain("missing =3\\b|\\(2,3\\)|minim\\w*.{0,60}3\\b");
      expect(ok(solution, `${worked}\nQuanto vale f(2)?`)).toHaveLength(1);
    });

    it("accept a confirmation with the final result and a further check, and reject handing the done step back", () => {
      const end = "guide-to-the-end";
      expect(ok(end, "Right: $x = 2$ and $f(2) = 3$, so the minimum is 3. To be sure it is a minimum, what does $f''(x)$ tell you?")).toEqual([]);
      expect(ok(end, "Right. What is f(2) then?")).not.toEqual([]);
      expect(ok(end, "x = 2 and f(2) = 3.")).toEqual([expect.stringContaining("missing [Rr]ight")]);
    });
  });
});
