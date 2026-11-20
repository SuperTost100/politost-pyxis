/** What replaying keys needs of a field: to be sent a command, as MathLive's is. */
type Typing = { executeCommand(command: unknown): unknown };

/**
 * Types into a field the keys that were typed while MathLive loaded, with braces read as they are when typed live
 * (`braces.key`, which says whether it dealt with a key). A `\` typed live starts LaTeX mode, but typed as text it is only
 * a character, so a brace after it must not be read as a group: `\{` and `\}` are the braces that show, and are
 * inserted as such before braces are read.
 */
export function replayKeys<Field extends Typing>(
  field: Field,
  braces: { key(field: Field, key: string): boolean },
  keys: string,
): void {
  let run = "";
  const flush = () => {
    if (run) field.executeCommand(["typedText", run, { focus: true, feedback: false }]);
    run = "";
  };
  for (let at = 0; at < keys.length; at += 1) {
    const key = keys[at]!;
    const next = keys[at + 1];
    if (key === "\\" && (next === "{" || next === "}")) {
      flush();
      field.executeCommand(["insert", next === "{" ? "\\lbrace" : "\\rbrace", { format: "latex", focus: true, feedback: false }]);
      at += 1;
      continue;
    }
    if (key === "{" || key === "}" || /^\d$/.test(key)) flush();
    if (!braces.key(field, key)) run += key;
  }
  flush();
}
