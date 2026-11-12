import { describe, expect, it } from "vitest";
import { answerWay, wayOfTemplate } from "./way";

describe("the way Pyxis answers", () => {
  it("solves a question or an exercise that asks for nothing else", () => {
    expect(answerWay({ text: "Calcola il campo elettrico a 5 cm da un filo con λ = 2 nC/m." })).toBe("solved");
    expect(answerWay({ text: "Che cos'è il teorema di Bayes?" })).toBe("solved");
    expect(answerWay({ text: "Explain Gauss's law" })).toBe("solved");
  });

  it("guides when the student asks for help understanding, to be guided, or shows an attempt", () => {
    for (const text of [
      "Non ho capito come si trova il campo di un filo carico con Gauss. Mi aiuti a ragionarci?",
      "Guidami passo passo",
      "Ho provato e mi viene x = 3, è giusto?",
      "Sono bloccato su questo integrale",
      "I don't understand this limit, walk me through it",
      "Can you give me a hint?",
    ])
      expect(answerWay({ text }), text).toBe("guided");
  });

  it("solves when the student asks for the solution, even after saying they are stuck", () => {
    expect(answerWay({ text: "Non ho capito, dammi la soluzione", previous: "guided" })).toBe("solved");
    expect(answerWay({ text: "Just tell me the answer", previous: "guided" })).toBe("solved");
  });

  it("keeps guiding while the student answers a guided step", () => {
    expect(answerWay({ text: "Un cilindro coassiale", previous: "guided" })).toBe("guided");
    expect(answerWay({ text: "Un cilindro coassiale", previous: "solved" })).toBe("solved");
  });

  it("follows the way asked for under an answer", () => {
    expect(answerWay({ text: "Dammi la soluzione", asked: "guided" })).toBe("guided");
    expect(answerWay({ text: "Guidami", asked: "solved" })).toBe("solved");
  });

  it("reads the way of a stored reply from its template", () => {
    expect(wayOfTemplate("chat.socratic")).toBe("guided");
    expect(wayOfTemplate("chat.solver")).toBe("solved");
    expect(wayOfTemplate("chat.general")).toBe("solved");
    expect(wayOfTemplate(null)).toBe("solved");
  });
});
