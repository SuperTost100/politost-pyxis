/**
 * A Pyxis tool's result sits in a chat reply as a fenced block in the language `pyxis-tool` whose one line is the result's
 * id, or `pending:<tool>` while the tool runs. Core writes these blocks where the model called the tool; text the model
 * wrote itself never becomes one (`spliceToolBlocks` in `core/tools/results.ts`).
 */
export const TOOL_FENCE = "pyxis-tool";

const BLOCK = /^```pyxis-tool\n([^\n]*)\n```$/gm;

/** The result ids a reply's text names, in order. Pending blocks are left out. */
export function toolBlockIds(body: string): string[] {
  return [...body.matchAll(BLOCK)].map((match) => match[1]!.trim()).filter((id) => /^[0-9a-f-]{36}$/.test(id));
}

/** A reply's text with each tool block replaced by what `describe` says of its line (a result id, or `pending:<tool>`). */
export function mapToolBlocks(body: string, describe: (line: string) => string): string {
  return body.includes(TOOL_FENCE) ? body.replace(BLOCK, (_, line: string) => describe(line.trim())) : body;
}

/** A reply's text without its tool blocks: what is read aloud, copied, searched or exported as the reply's own words. */
export function stripToolBlocks(body: string): string {
  return mapToolBlocks(body, () => "").replace(/\n{3,}/g, "\n\n");
}
