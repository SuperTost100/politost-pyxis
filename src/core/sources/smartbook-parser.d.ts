declare module "@politost/smartbook-parser" {
  export function parseChapterMarkdown(
    raw: string,
    chapterNumber: number,
  ): {
    paragraphs: Array<{ id: string; title: string; content: string }>;
  };

  export function parseExercises(
    raw: string,
    defaultType?: "esercizio" | "esame",
  ): Array<{
    id: string;
    chapter?: number;
    question: string;
    solution?: string;
  }>;
}
