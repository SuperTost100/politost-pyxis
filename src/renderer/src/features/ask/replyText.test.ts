import { describe, expect, it } from "vitest";
import { answerPreview, replyPlainText } from "./replyText";

describe("replyPlainText", () => {
  it("drops check blocks and passage markers", () => {
    const body =
      'La derivata è $2x$ [P3].\n\n```check\n{"kind":"derivative","expr":"x^2","claimed":"2x"}\n```\n\nPoi integra [P1; P2].';
    expect(replyPlainText(body)).toBe("La derivata è $2x$.\n\nPoi integra.");
  });

  it("keeps ordinary code blocks", () => {
    const body = "Prova:\n\n```python\nprint(1)\n```";
    expect(replyPlainText(body)).toBe(body);
  });
});

describe("answerPreview", () => {
  it("takes the Markdown marks and passage markers off, on one line", () => {
    const body = "## Il blocco\n\nLa **forza** vale $mg \\sin\\theta$ [P2], vedi [la lezione](https://x.y).\n\n- primo\n- secondo";
    expect(answerPreview(body)).toBe("Il blocco La forza vale mg \\sin\\theta, vedi la lezione. primo secondo");
  });

  it("is empty for an empty reply", () => {
    expect(answerPreview("")).toBe("");
  });
});
