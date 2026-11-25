import { describe, expect, it } from "vitest";
import { currentMark, firstLine, jumpRange, MARKS_FROM, outlineLeft, outlineMarks, pinnedMark, plainReading, type OutlineRow } from "./outline";

const rows = (count: number): OutlineRow[] =>
  Array.from({ length: count }, (_, i) => [
    { id: `q${i}`, role: "user" as const, body: `Domanda ${i}\nsecondo rigo` },
    { id: `a${i}`, role: "assistant" as const, body: `**Risposta** ${i} con del testo` },
  ]).flat();

const plain = (text: string) => text.replace(/\*\*/g, "");

describe("outlineMarks", () => {
  it("has no marks before the third question", () => {
    expect(MARKS_FROM).toBe(3);
    expect(outlineMarks(rows(2), plain)).toEqual([]);
    expect(outlineMarks([], plain)).toEqual([]);
  });

  it("has one mark per question from the third on, with its row, first line and the start of its answer", () => {
    const marks = outlineMarks(rows(3), plain);
    expect(marks).toHaveLength(3);
    expect(marks[2]).toEqual({ id: "q2", row: 4, question: "Domanda 2", answer: "Risposta 2 con del testo" });
  });

  it("gives a question without an answer yet an empty answer, and counts every question", () => {
    const marks = outlineMarks([...rows(3), { id: "q3", role: "user", body: "Ultima" }], plain);
    expect(marks).toHaveLength(4);
    expect(marks[3]).toMatchObject({ id: "q3", row: 6, question: "Ultima", answer: "" });
  });

  it("cuts a long answer at a word", () => {
    const long = Array.from({ length: 80 }, () => "parola").join(" ");
    const third = outlineMarks([...rows(2), { id: "q2", role: "user", body: "x" }, { id: "a2", role: "assistant", body: long }], plain)[2]!;
    expect(third.answer.length).toBeLessThanOrEqual(221);
    expect(third.answer.endsWith("…")).toBe(true);
  });
});

describe("a formula in the card", () => {
  const long = (formula: string) => `${Array.from({ length: 29 }, () => "parola").join(" ")} ${formula} e altro testo`;

  it("is never cut in half: a formula the cut reaches into is left out whole", () => {
    const third = outlineMarks([...rows(2), { id: "q2", role: "user", body: "x" }, { id: "a2", role: "assistant", body: long("$N = mg\\cos\\theta$") }], plain)[2]!;
    expect((third.answer.match(/\$/g) ?? []).length % 2).toBe(0);
    expect(third.answer.endsWith("…")).toBe(true);
  });

  it("keeps a formula the cut does not reach", () => {
    const short = outlineMarks([...rows(2), { id: "q2", role: "user", body: "x" }, { id: "a2", role: "assistant", body: "Vale $N = mg$ qui." }], plain)[2]!;
    expect(short.answer).toBe("Vale $N = mg$ qui.");
  });
});

describe("plainReading", () => {
  it("writes a formula in plain words and never leaves TeX", () => {
    expect(plainReading("Quanto vale $N = mg\\cos\\theta$ con $\\mu_s$?")).toBe("Quanto vale N = mgcosθ con μ_s?");
    expect(plainReading("$$F = m\\cdot a$$")).toBe("F = m· a");
    expect(plainReading("Nessuna formula")).toBe("Nessuna formula");
  });

  it("reads a figure's caption: fractions, units, vectors and powers without their markup", () => {
    expect(plainReading("La velocità $v(t)=2+1{,}5\\,t$ e $x(t) = \\tfrac12 a t^2$ per $a = 2\\,\\mathrm{m/s^2}$.")).toBe(
      "La velocità v(t)=2+1,5 t e x(t) = 1/2 a t² per a = 2 m/s².",
    );
    expect(plainReading("La somma di $\\vec F_1$ e $\\vec F_2$.")).toBe("La somma di F_1 e F_2.");
    expect(plainReading("$\\frac{mg}{2}$")).toBe("mg/2");
  });
});

describe("plainReading keeps what a formula means", () => {
  it("reads a whole exponent, not its first digit", () => {
    expect(plainReading("$x^{20}$")).toBe("x^20");
    expect(plainReading("$x^{n+1}$")).toBe("x^(n+1)");
    expect(plainReading("$x^2$ e $y^{3}$ e $z^n$")).toBe("x² e y³ e z^n");
    expect(plainReading("$e^{-t/\\tau}$")).toBe("e^(-t/τ)");
  });

  it("keeps the grouping of a fraction whose parts are not single terms", () => {
    expect(plainReading("$\\frac{a+b}{c+d}$")).toBe("(a+b)/(c+d)");
    expect(plainReading("$\\frac{mg}{2}$")).toBe("mg/2");
    // A fraction raised to a power keeps its grouping.
    expect(plainReading("$\\frac{a}{b}^{2}$")).toBe("(a/b)²");
    expect(plainReading("$\\frac{a+1}{b}^{n}$")).toBe("((a+1)/b)^n");
    expect(plainReading("$\\tfrac12^2$")).toBe("(1/2)²");
    expect(plainReading("$\\frac{a+b}{2}$")).toBe("(a+b)/2");
    expect(plainReading("$\\tfrac12$")).toBe("1/2");
  });

  it("reads a fraction inside a fraction", () => {
    expect(plainReading("$\\frac{\\frac{a}{b}}{c}$")).toBe("(a/b)/c");
    expect(plainReading("$\\frac{1}{1+\\frac{1}{x}}$")).toBe("1/(1+1/x)");
    expect(plainReading("$\\frac{x^{2}}{y^{20}}$")).toBe("x²/y^20");
  });
});

describe("pinnedMark", () => {
  const pin = { chat: "a", index: 0, top: 0 };

  it("holds while the page stays where the jump left it, in the same chat", () => {
    expect(pinnedMark(pin, "a", 0)).toBe(0);
    expect(pinnedMark(pin, "a", 20)).toBe(0);
  });

  it("lets go once the student scrolls away", () => {
    expect(pinnedMark(pin, "a", 60)).toBeNull();
  });

  it("does not follow the student to another chat, even when both fit the window at scroll 0", () => {
    expect(pinnedMark(pin, "b", 0)).toBeNull();
    expect(pinnedMark(null, "a", 0)).toBeNull();
  });
});

describe("firstLine", () => {
  it("is the first line with text, with its spaces squeezed", () => {
    expect(firstLine("\n\n  Quanto   vale\nla forza normale?")).toBe("Quanto vale");
    expect(firstLine("")).toBe("");
  });
});

describe("currentMark", () => {
  it("is the last question that starts above the line", () => {
    expect(currentMark([-900, -300, 120, 500], 200)).toBe(2);
    expect(currentMark([-900, -300, 120, 500], 600)).toBe(3);
  });

  it("is the first question shown while the line is above all of them", () => {
    expect(currentMark([300, 700], 100)).toBe(0);
  });

  it("skips questions that are not rendered", () => {
    expect(currentMark([null, null, -50, 400], 100)).toBe(2);
    expect(currentMark([null, 900], 100)).toBe(1);
    expect(currentMark([null, null], 100)).toBe(-1);
  });
});

describe("currentMark at the end of the page", () => {
  it("is the last question, whose answer fills the window", () => {
    expect(currentMark([-1500, -900, 400], 290, true)).toBe(2);
    expect(currentMark([-1500, -900, 400], 290)).toBe(1);
  });

  it("is not the last question when that one is not rendered", () => {
    expect(currentMark([-100, null], 290, true)).toBe(0);
  });
});

describe("jumpRange", () => {
  it("loads the messages from the question when it is before the rendered part", () => {
    expect(jumpRange(10, 4)).toBe(4);
  });

  it("leaves the range alone when the question is rendered", () => {
    expect(jumpRange(10, 10)).toBe(10);
    expect(jumpRange(10, 14)).toBe(10);
  });
});

describe("outlineLeft", () => {
  it("sits 6 px past the chat pane's left edge when there is room left of the message column", () => {
    expect(outlineLeft(260, 410)).toBe(266);
    expect(outlineLeft(76, 158)).toBe(82);
    expect(outlineLeft(92, 166)).toBe(98);
    expect(outlineLeft(260, 300)).toBe(266);
  });

  it("hides when fewer than 40 px separate the pane edge from the message column, or when either is missing", () => {
    expect(outlineLeft(260, 299)).toBeNull();
    expect(outlineLeft(260, 284)).toBeNull();
    expect(outlineLeft(undefined, 410)).toBeNull();
    expect(outlineLeft(260, undefined)).toBeNull();
  });
});
