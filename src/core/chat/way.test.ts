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

  it("guides when a solve verb only names what the student wants help with, or when the solution is refused", () => {
    for (const text of [
      "Guidami passo passo a risolvere questo integrale",
      "Walk me through how to solve this integral",
      "Non darmi la soluzione, guidami passo passo",
      "Don't give me the answer, just guide me",
      "Senza darmi la soluzione, aiutami a ragionare",
      "Non riesco a risolvere questo limite",
      "Aiutami a risolvere questo esercizio",
      "Can you help me solve this?",
    ])
      expect(answerWay({ text }), text).toBe("guided");
  });

  it("solves when the student asks for the solution or the result, in the words a student uses", () => {
    for (const text of [
      "Non ho capito, dammi la soluzione",
      "Non ho capito niente, risolvilo tu",
      "Puoi risolvermi questo integrale?",
      "Svolgi l'esercizio 3",
      "Qual è la soluzione dell'esercizio 3?",
      "Dimmi il risultato",
      "Quanto viene il limite per x che tende a 0?",
      "Solve x^2 - 4 = 0",
      "I'm stuck, just give me the answer",
      "Don't get me wrong, I need the full answer",
    ])
      expect(answerWay({ text }), text).toBe("solved");
  });

  it("solves a request to explain, to see the steps or to know how it is done, which has no cue for guiding", () => {
    for (const text of [
      "Mi spieghi come si risolve questo integrale?",
      "Come si fa?",
      "Come faccio a risolvere un'equazione di secondo grado?",
      "Fammi vedere i passaggi",
      "Spiegami questo passaggio",
      "How do I solve a quadratic equation?",
      "Show me the steps",
    ])
      expect(answerWay({ text }), text).toBe("solved");
  });

  it("guides when the student cannot follow, does not know where to start, or shows what they got", () => {
    for (const text of [
      "Non riesco a capire come si arriva al risultato",
      "Non so da dove cominciare",
      "Mi dai una mano a capire la regola della catena?",
      "Aiutami con questo esercizio",
      "Can you help me with this problem?",
      "Mi viene 3, ho fatto bene?",
      "Dammi un suggerimento",
      "Il risultato è 4, è corretto?",
    ])
      expect(answerWay({ text }), text).toBe("guided");
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
