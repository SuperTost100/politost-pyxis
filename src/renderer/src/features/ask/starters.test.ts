import { describe, expect, it } from "vitest";
import { activePlans, starterPrompts, type StarterPlan } from "./starters";

const topics = [
  { id: "t1", title: "Cinematica" },
  { id: "t2", title: "Dinamica" },
  { id: "t3", title: "Legge di Gauss" },
];

describe("activePlans", () => {
  it("keeps built plans whose exam is ahead or undated, nearest first", () => {
    const plans = [
      { id: "a", status: "ready", daysToExam: 3 },
      { id: "b", status: "building", daysToExam: 5 },
      { id: "c", status: "ready", daysToExam: null },
      { id: "d", status: "ready", daysToExam: -2 },
      { id: "e", status: "ready", daysToExam: 10 },
    ];
    expect(activePlans(plans).map((plan) => plan.id)).toEqual(["a", "c"]);
  });
});

describe("starterPrompts", () => {
  it("returns nothing without a plan that has topics", () => {
    expect(starterPrompts([])).toEqual([]);
    expect(starterPrompts([{ id: "p", subject: null, topics: [], studied: [] }])).toEqual([]);
  });

  it("explains the next topic, quizzes the one studied last and adds an exercise with one plan", () => {
    const plan: StarterPlan = { id: "p", subject: "Fisica", topics, studied: ["t1", "t2", "t1"] };
    expect(starterPrompts([plan])).toEqual([
      { kind: "explain", topic: "Legge di Gauss", planId: "p", subject: "Fisica" },
      { kind: "quiz", topic: "Cinematica", planId: "p", subject: "Fisica" },
      { kind: "exercise", topic: "Legge di Gauss", planId: "p", subject: "Fisica" },
    ]);
  });

  it("quizzes the topic after the next one when nothing is studied yet", () => {
    const plan: StarterPlan = { id: "p", subject: null, topics, studied: [] };
    expect(starterPrompts([plan]).map((item) => [item.kind, item.topic])).toEqual([
      ["explain", "Cinematica"],
      ["quiz", "Dinamica"],
      ["exercise", "Cinematica"],
    ]);
  });

  it("uses the second plan's next topic in place of the exercise", () => {
    const first: StarterPlan = { id: "p", subject: "Fisica", topics: [topics[0]!], studied: [] };
    const second: StarterPlan = {
      id: "q",
      subject: "Analisi",
      topics: [{ id: "s1", title: "Integrali" }],
      studied: [],
    };
    expect(starterPrompts([first, second])).toEqual([
      { kind: "explain", topic: "Cinematica", planId: "p", subject: "Fisica" },
      { kind: "explain", topic: "Integrali", planId: "q", subject: "Analisi" },
    ]);
  });
});
