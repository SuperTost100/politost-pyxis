// The recorded engine's replies for a lesson in parts: a teaching part and the recap, in the shape a written part has.

const fence = (kind: string, body: unknown) => ["```" + kind, JSON.stringify(body), "```"].join("\n");

/** Prose for one section of a part: enough words that each part has the length a part must have. */
function prose(name: string): string {
  return Array.from(
    { length: 7 },
    (_, i) => `${name} torna in molti esercizi del corso, e questa frase numero ${i + 1} lo spiega con calma e con un esempio.`,
  ).join(" ");
}

/** A teaching part as the model writes it: an opening, two sections, one check whose right answer is B, the takeaway. */
export function partText(name: string): string {
  return [
    `Qui si parla di ${name.toLowerCase()}.`,
    "",
    `## ${name}: l'idea`,
    "",
    prose(name),
    "",
    prose(name),
    "",
    `## ${name}: un esempio`,
    "",
    prose(name),
    "",
    prose(name),
    "",
    fence("pyxis-check", {
      question: `Che cosa dice la parte su ${name.toLowerCase()}?`,
      options: ["Una cosa sbagliata", "La cosa giusta", "Un'altra cosa"],
      answer: 1,
      explanation: "Lo dice la parte che hai letto.",
    }),
    "",
    fence("pyxis-takeaway", { text: `Riassunto di ${name.toLowerCase()}: la cosa giusta. Serve nella parte dopo.` }),
  ].join("\n");
}

/** The recap part: one section with a point per part, the closing recap of three questions, the takeaway. */
export const recapText = [
  "## Il capitolo in breve",
  "",
  "- Intorni e distanza.",
  "- Interno e frontiera.",
  "- Aperti e chiusi.",
  "- Compatti e connessi.",
  "",
  fence("pyxis-recap", {
    questions: [1, 2, 3].map((n) => ({
      question: `Domanda di ripasso ${n}?`,
      options: ["Giusta", "Sbagliata"],
      answer: 0,
    })),
  }),
  "",
  fence("pyxis-takeaway", { text: "Il capitolo in breve: intorni, frontiera, aperti, compatti." }),
].join("\n");
