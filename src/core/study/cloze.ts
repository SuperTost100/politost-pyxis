// Anki cloze markup: {{c1::answer}} or {{c1::answer::hint}}. A card is a cloze when its front holds a deletion.
const deletion = () => /\{\{c(\d{1,2})::([\s\S]+?)(?:::([^{}]*?))?\}\}/g;

export function isCloze(front: string): boolean {
  return deletion().test(front);
}

/** Front shown while studying: every deletion becomes a bold blank, or its hint. */
export function clozeQuestion(text: string): string {
  return text.replace(deletion(), (_, _n, _answer, hint?: string) =>
    hint?.trim() ? `**(${hint.trim()})**` : "**(…)**",
  );
}

/** Same sentence with every deletion filled in and emphasised. */
export function clozeAnswer(text: string): string {
  return text.replace(deletion(), (_, _n, answer: string) => `**${answer.trim()}**`);
}
