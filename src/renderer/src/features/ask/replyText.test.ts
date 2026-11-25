import { describe, expect, it } from "vitest";
import { chatQuestion } from "../../../../shared/chat-blocks";
import { answerPreview, replyPlainText } from "./replyText";

describe("replyPlainText", () => {
  it("drops check blocks and passage markers", () => {
    const body =
      'La derivata è $2x$ [P3].\n\n```check\n{"kind":"derivative","expr":"x^2","claimed":"2x"}\n```\n\nPoi integra [P1; P2].';
    expect(replyPlainText(body)).toBe("La derivata è $2x$.\n\nPoi integra.");
  });

  it("copies a chart as its table and a question with the student's answer, never their JSON", () => {
    const chart = { title: "Voti", kind: "bar", unit: "/30", series: [{ name: "Voto", points: [{ label: "Cinematica", value: 26 }] }] };
    const question = { question: "Quanto fa 2+2?", options: ["3", "4"], answer: 1 };
    const body = `Ecco.\n\n\`\`\`pyxis-chart\n${JSON.stringify(chart)}\n\`\`\`\n\n\`\`\`pyxis-question\n${JSON.stringify(question)}\n\`\`\``;
    const id = chatQuestion(JSON.stringify(question))!.id;
    const text = replyPlainText(body, "en", { [id]: 0 });
    expect(text).toContain("| Cinematica | 26/30 |");
    expect(text).toMatch(/\. 3 \(your answer\)/);
    expect(text).toMatch(/\. 4 \(the right one\)/);
    expect(text).not.toMatch(/pyxis-|"options"|"series"/);
  });

  it("keeps ordinary code blocks", () => {
    const body = "Prova:\n\n```python\nprint(1)\n```";
    expect(replyPlainText(body)).toBe(body);
  });
});

describe("answerPreview", () => {
  it("takes the Markdown marks and passage markers off, on one line, and keeps the formulas for the card to draw", () => {
    const body = "## Il blocco\n\nLa **forza** vale $mg \\sin\\theta$ [P2], vedi [la lezione](https://x.y).\n\n- primo\n- secondo con $\\mu_s N$";
    expect(answerPreview(body)).toBe("Il blocco La forza vale $mg \\sin\\theta$, vedi la lezione. primo secondo con $\\mu_s N$");
  });

  it("keeps the underscores of a formula and writes a display formula inline", () => {
    expect(answerPreview("Sia $$F_{net} = m a$$ la legge.")).toBe("Sia $F_{net} = m a$ la legge.");
  });

  it("is empty for an empty reply", () => {
    expect(answerPreview("")).toBe("");
  });
});
