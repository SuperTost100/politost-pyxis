import { describe, expect, it } from "vitest";
import { noteLine, usedLine } from "./usedLine";

const cite = (sourceId: string, subject: string | null, attached = false) => ({ sourceId, subject, attached });

describe("the line that says what an answer used", () => {
  it("names the one subject the cited files belong to", () => {
    expect(
      usedLine({ grounding: "sources", citations: [cite("a", "Fisica 2"), cite("b", "Fisica 2"), cite("a", "Fisica 2")] }),
    ).toEqual({ key: "ask.used.subject", values: { count: 2, subject: "Fisica 2" } });
  });

  it("counts files, not passages: three citations from two files are two sources", () => {
    expect(usedLine({ grounding: "sources", citations: [cite("a", "Fisica 2"), cite("a", "Fisica 2"), cite("a", "Fisica 2")] })).toEqual({
      key: "ask.used.subject",
      values: { count: 1, subject: "Fisica 2" },
    });
    expect(usedLine({ grounding: "sources", citations: [cite("a", "Fisica 2"), cite("b", "Analisi 1"), cite("a", "Fisica 2")] })).toEqual({
      key: "ask.used.two",
      values: { count: 2, first: "Fisica 2", second: "Analisi 1" },
    });
    expect(usedLine({ grounding: "wider", citations: [cite("a", null), cite("a", null), cite("b", null)] })).toEqual({
      key: "ask.used.library",
      values: { count: 2, context: "wider" },
    });
  });

  it("names two subjects, and says 'your Library' for more or for files without a subject", () => {
    expect(usedLine({ grounding: "sources", citations: [cite("a", "Fisica 2"), cite("b", "Analisi 1")] })).toEqual({
      key: "ask.used.two",
      values: { count: 2, first: "Fisica 2", second: "Analisi 1" },
    });
    expect(
      usedLine({ grounding: "sources", citations: [cite("a", "Fisica 2"), cite("b", "Analisi 1"), cite("c", "Chimica")] }),
    ).toEqual({ key: "ask.used.library", values: { count: 3 } });
    expect(usedLine({ grounding: "sources", citations: [cite("a", "Fisica 2"), cite("b", null)] })).toEqual({
      key: "ask.used.library",
      values: { count: 2 },
    });
  });

  it("says the chat's subject had nothing when the answer looked wider", () => {
    expect(usedLine({ grounding: "wider", citations: [cite("a", "Analisi 1"), cite("b", "Analisi 1")] })).toEqual({
      key: "ask.used.subject",
      values: { count: 2, subject: "Analisi 1", context: "wider" },
    });
  });

  it("names the attached file when the answer used only that, by files", () => {
    expect(usedLine({ grounding: "sources", citations: [cite("att", null, true), cite("att", null, true)] })).toEqual({
      key: "ask.used.attached",
      values: { count: 1 },
    });
    // An attachment beside the Library is part of what the student brought.
    expect(usedLine({ grounding: "sources", citations: [cite("att", null, true), cite("a", "Fisica 2")] })).toEqual({
      key: "ask.used.library",
      values: { count: 2 },
    });
  });

  it("says plainly when the answer comes from general knowledge, and says nothing when nothing was searched", () => {
    expect(usedLine({ grounding: "general", citations: [], searched: { found: false, where: "library" } })).toEqual({
      key: "ask.used.general",
      values: {},
    });
    expect(usedLine({ grounding: null, citations: [] })).toBeNull();
    // An attached file with no citation makes no claim either.
    expect(usedLine({ grounding: "sources", citations: [] })).toBeNull();
  });

  it("says where Pyxis looked when it found nothing, and that the answer cites nothing when it found something", () => {
    const none = { grounding: "general", citations: [] } as const;
    expect(usedLine({ ...none, searched: { found: false, where: "library" } })).toEqual({ key: "ask.used.general", values: {} });
    // A chat limited to files picked by hand did not look in the whole Library, and must not say so.
    expect(usedLine({ ...none, searched: { found: false, where: "files" } })).toEqual({ key: "ask.used.generalFiles", values: {} });
    expect(usedLine({ ...none, searched: { found: true, where: "library" } })).toEqual({ key: "ask.used.generalUnused", values: {} });
    expect(usedLine({ ...none, searched: { found: true, where: "files" } })).toEqual({ key: "ask.used.generalUnused", values: {} });
    // A reply saved without the note, or stopped, only says what is known: it cites no source.
    expect(usedLine(none)).toEqual({ key: "ask.used.generalNoSource", values: {} });
  });
});

describe("noteLine", () => {
  it("keeps only the warnings above an answer: general knowledge, or a subject that had nothing", () => {
    expect(noteLine({ grounding: "general", citations: [] })).toEqual({ key: "ask.used.generalNoSource", values: {} });
    expect(noteLine({ grounding: "wider", citations: [cite("a", "Analisi 1")] })).toEqual({
      key: "ask.used.subject",
      values: { count: 1, subject: "Analisi 1", context: "wider" },
    });
    expect(noteLine({ grounding: "sources", citations: [cite("a", "Fisica 2")] })).toBeNull();
    expect(noteLine({ grounding: null, citations: [] })).toBeNull();
  });
});

describe("noteLine, on a reply that explains nothing", () => {
  const general = { grounding: "general", citations: [], searched: { found: false, where: "library" } } as const;
  const tool = "```pyxis-tool\n0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b\n```";

  it("says nothing above a reply whose substance is a tool's result or a proposal", () => {
    expect(noteLine({ ...general, body: `Te le preparo.\n\n${tool}\n\nLe trovi nel mazzo.` })).toBeNull();
    expect(noteLine({ ...general, searched: { found: true, where: "library" }, body: `Ecco la proposta.\n\n${tool}` })).toBeNull();
    // A reply built on the student's own results speaks of their numbers, not of where an explanation came from.
    expect(noteLine({ ...general, results: true, body: "Nell'ultimo quiz hai preso 26/30.\n\n```pyxis-chart\n{}\n```" })).toBeNull();
  });

  it("says nothing above a short plain reply: a refusal or a question back, with no explanation in it", () => {
    const refusal =
      "No, non posso cambiare il voto dell'ultimo quiz. I risultati indicano il tuo livello di preparazione, quindi possono cambiare solo attraverso il tuo lavoro.\n\nPuoi rifare il quiz dalla pagina dei risultati, oppure segnalare una domanda poco chiara con «Domanda sbagliata?».";
    expect(noteLine({ ...general, body: refusal })).toBeNull();
    expect(
      noteLine({ ...general, searched: { found: true, where: "library" }, body: "Di quale argomento vuoi cancellare le flashcard?" }),
    ).toBeNull();
  });

  it("keeps the note above an answer from general knowledge: one with math, a list or a block, or a long one", () => {
    const line = { key: "ask.used.general", values: {} };
    expect(noteLine({ ...general, body: "Un autovalore è un numero $\\lambda$ per cui $Av = \\lambda v$ con $v \\neq 0$." })).toEqual(line);
    expect(noteLine({ ...general, body: "Le tre leggi:\n\n1. inerzia\n2. $F = ma$\n3. azione e reazione" })).toEqual(line);
    expect(noteLine({ ...general, body: "Ecco il grafico.\n\n```pyxis-figure\n{}\n```" })).toEqual(line);
    expect(noteLine({ ...general, body: "Il teorema di Cauchy-Lipschitz garantisce esistenza e unicità locale. ".repeat(10) })).toEqual(line);
    // A tool block in a reply that also cites nothing but explains at length is still an action: the card is the answer.
    expect(noteLine({ ...general, body: `Ecco le flashcard.\n\n${tool}` })).toBeNull();
  });
});
