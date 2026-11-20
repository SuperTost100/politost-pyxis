import { describe, expect, it } from "vitest";
import { replayKeys } from "./replayKeys";

/** A field that only records the commands it is sent, and braces that read no key, as with nothing known of the model. */
function recorder() {
  const commands: unknown[] = [];
  const field = {
    executeCommand: (command: unknown) => {
      commands.push(command);
    },
  };
  return { field, commands };
}
const noBraces = { key: () => false };
const typed = (text: string) => ["typedText", text, { focus: true, feedback: false }];
const insert = (latex: string) => ["insert", latex, { format: "latex", focus: true, feedback: false }];

describe("keys typed before MathLive had loaded", () => {
  it("are typed as a run, and a digit or a brace ends the run", () => {
    const { field, commands } = recorder();
    replayKeys(field, noBraces, "A=x12");
    // With no model to ask, a brace or a digit is not read as a group, and the keys still arrive in order.
    expect(commands).toEqual([typed("A=x"), typed("1"), typed("2")]);
  });

  it("read \\{ and \\} as the braces that show, not as a group, whatever the text between them", () => {
    const { field, commands } = recorder();
    replayKeys(field, noBraces, "A=\\{1,2\\}");
    expect(commands).toEqual([typed("A="), insert("\\lbrace"), typed("1,"), typed("2"), insert("\\rbrace")]);
  });

  it("keep a backslash that is not before a brace as the text it was", () => {
    const { field, commands } = recorder();
    replayKeys(field, noBraces, "a\\b");
    expect(commands).toEqual([typed("a\\b")]);
  });
});
