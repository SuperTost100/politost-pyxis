/** Words a model id spells in lower case that read in capitals. */
const UPPER = new Set(["gpt", "glm", "oss", "ai"]);

/**
 * A model id as a student can read it, for a model whose list has not been read: "claude-sonnet-4-6" reads
 * "Claude Sonnet 4.6", "gemini-3.8-flash" reads "Gemini 3.8 Flash" and "gpt-5.3-codex" reads "GPT-5.3 Codex". The
 * engine's own name for a model, when Pyxis has its list, wins over this.
 */
export function readableModel(id: string): string {
  const tokens = id
    .replace(/[-@](?:\d{8}|\d{4}-\d{2}-\d{2})$/, "")
    .split(/[-_:\s]+/)
    .filter(Boolean);
  // Cursor names its own builds of a model "cursor-grok-…": the model is Grok.
  if (tokens.length > 1 && tokens[0]!.toLowerCase() === "cursor") tokens.shift();
  const words: string[] = [];
  for (const token of tokens) {
    const previous = words[words.length - 1];
    // "4-6" is version 4.6: a bare number after a number continues the version.
    if (/^\d+$/.test(token) && previous && /^\d+(?:\.\d+)*$/.test(previous)) {
      words[words.length - 1] = `${previous}.${token}`;
      continue;
    }
    if (/^\d+(?:\.\d+)*$/.test(token) && previous && previous === "GPT") {
      words[words.length - 1] = `GPT-${token}`;
      continue;
    }
    const lower = token.toLowerCase();
    if (UPPER.has(lower)) words.push(lower.toUpperCase());
    else if (/^\d+(?:\.\d+)?[bm]$/i.test(token)) words.push(token.toUpperCase());
    else words.push(token.charAt(0).toUpperCase() + token.slice(1));
  }
  return words.join(" ") || id;
}
