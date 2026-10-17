import { describe, expect, it } from "vitest";
import {
  CODE_KEY,
  MAX_SNIPPETS,
  SNIPPETS_KEY,
  addSnippet,
  readCode,
  readSnippets,
  snippetName,
  writeCode,
  writeSnippets,
} from "./pythonCode";

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("Python page storage", () => {
  it("gives back the code written before, and the example when there is none", () => {
    const storage = memory();
    expect(readCode(storage, "print(1 + 1)", 8000)).toBe("print(1 + 1)");
    writeCode(storage, "x = 2\nprint(x)");
    expect(readCode(storage, "print(1 + 1)", 8000)).toBe("x = 2\nprint(x)");
    // An empty editor is a choice the student made, not missing code.
    writeCode(storage, "");
    expect(readCode(storage, "print(1 + 1)", 8000)).toBe("");
  });

  it("ignores stored code over the run limit and storage that throws", () => {
    expect(readCode(memory({ [CODE_KEY]: "x".repeat(20) }), "ok", 10)).toBe(
      "ok",
    );
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(readCode(broken, "ok", 10)).toBe("ok");
    expect(readSnippets(broken, 10)).toEqual([]);
    expect(() => writeCode(broken, "x")).not.toThrow();
    expect(() => writeSnippets(broken, [])).not.toThrow();
  });

  it("names a snippet by its first line with text", () => {
    expect(snippetName("\n\n  import math  \nprint(math.pi)")).toBe(
      "import math",
    );
    expect(snippetName("   \n")).toBe("");
    const long = snippetName(`# ${"a".repeat(80)}`);
    expect(long).toHaveLength(48);
    expect(long.endsWith("…")).toBe(true);
  });

  it("keeps snippets newest first, without duplicates, up to the limit", () => {
    let list = addSnippet([], "print(1)");
    list = addSnippet(list, "print(2)");
    list = addSnippet(list, "print(1)");
    expect(list.map((item) => item.code)).toEqual(["print(1)", "print(2)"]);
    expect(addSnippet(list, "  \n")).toBe(list);
    for (let i = 0; i < 20; i++) list = addSnippet(list, `print(${i + 10})`);
    expect(list).toHaveLength(MAX_SNIPPETS);
    expect(list[0]!.code).toBe("print(29)");
  });

  it("reads back only well-formed snippets", () => {
    const storage = memory({
      [SNIPPETS_KEY]: JSON.stringify([
        { name: "kept", code: "print(1)" },
        { name: "", code: "y = 3" },
        { name: "blank", code: "  " },
        { name: "long", code: "x".repeat(50) },
        { code: "print(2)" },
        "print(3)",
        null,
      ]),
    });
    expect(readSnippets(storage, 40)).toEqual([
      { name: "kept", code: "print(1)" },
      { name: "y = 3", code: "y = 3" },
    ]);
    expect(readSnippets(memory({ [SNIPPETS_KEY]: "{oops" }), 40)).toEqual([]);
    expect(readSnippets(memory({ [SNIPPETS_KEY]: '{"a":1}' }), 40)).toEqual([]);
    const round = memory();
    writeSnippets(round, [{ name: "a", code: "print('a')" }]);
    expect(readSnippets(round, 40)).toEqual([
      { name: "a", code: "print('a')" },
    ]);
  });
});
