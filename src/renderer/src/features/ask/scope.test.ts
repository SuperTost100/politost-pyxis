import { describe, expect, it } from "vitest";
import {
  addIds,
  allowsGeneral,
  applySubject,
  choseGeneral,
  newChatDefault,
  newChatSubject,
  scopeItems,
} from "./scope";

type Subjects = Array<{ name: string }>;

function later<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("chat scope", () => {
  it("swaps the previous subject's sources for the new one and keeps hand-picked ones", () => {
    expect(applySubject(["analisi-1", "mine"], ["analisi-1"], ["fisica-1", "fisica-2"])).toEqual([
      "mine",
      "fisica-1",
      "fisica-2",
    ]);
    expect(applySubject(["analisi-1"], ["analisi-1"], [])).toEqual([]);
    expect(applySubject(["a"], [], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("adds ids once", () => {
    expect(addIds(["a"], ["a", "b", "b"])).toEqual(["a", "b"]);
  });

  it("lists the plan first, then sources by title, and locks attached documents", () => {
    expect(
      scopeItems({
        planId: "p",
        planTitle: "Analisi 2",
        picked: ["s2", "s1", "doc", "gone"],
        library: [
          { id: "s1", title: "Dispense" },
          { id: "s2", title: "Appunti" },
        ],
        held: [{ id: "doc", title: "foto.png" }],
      }),
    ).toEqual([
      { kind: "plan", id: "p", title: "Analisi 2" },
      { kind: "source", id: "s2", title: "Appunti" },
      { kind: "source", id: "s1", title: "Dispense" },
      { kind: "source", id: "doc", title: "foto.png", locked: true },
    ]);
  });
});

describe("allowsGeneral", () => {
  it("is open when nothing narrows the chat to sources", () => {
    expect(allowsGeneral({ chosen: false, planId: null, sourceCount: 0 })).toBe(true);
    expect(allowsGeneral({ chosen: false, planId: undefined, sourceCount: 0, fileCount: 0 })).toBe(true);
  });

  it("stays closed with a plan, sources or an attached file", () => {
    expect(allowsGeneral({ chosen: false, planId: "p", sourceCount: 0 })).toBe(false);
    expect(allowsGeneral({ chosen: false, planId: null, sourceCount: 2 })).toBe(false);
    expect(allowsGeneral({ chosen: false, planId: null, sourceCount: 0, fileCount: 1 })).toBe(false);
  });

  it("keeps the student's choice to answer generally, as a retry needs", () => {
    expect(allowsGeneral({ chosen: true, planId: "p", sourceCount: 3, fileCount: 1 })).toBe(true);
  });
});

describe("choseGeneral", () => {
  const general = [
    { role: "user", grounding: null },
    { role: "assistant", grounding: "general" },
  ];

  it("keeps the choice made in this session", () => {
    expect(choseGeneral(false, general)).toBe(false);
    expect(choseGeneral(true, [])).toBe(true);
  });

  it("reads a reopened chat's choice from its last reply", () => {
    expect(choseGeneral(undefined, general)).toBe(true);
    expect(choseGeneral(undefined, [...general, { role: "user", grounding: null }])).toBe(true);
    expect(choseGeneral(undefined, [{ role: "assistant", grounding: "sources" }])).toBe(false);
    expect(choseGeneral(undefined, [])).toBe(false);
  });
});

describe("a new chat's subject", () => {
  it("is the student's only subject", () => {
    expect(newChatSubject([{ name: "Analisi 1" }])).toBe("Analisi 1");
  });
  it("stays empty with no subject or several", () => {
    expect(newChatSubject([])).toBe("");
    expect(newChatSubject([{ name: "Analisi 1" }, { name: "Fisica" }])).toBe("");
  });
});

describe("starting a new chat on the only subject", () => {
  it("holds a question sent while the subjects load until the subject and its sources are chosen", async () => {
    const list = later<Subjects>();
    const chosen: string[] = [];
    const defaults = newChatDefault(
      () => list.promise,
      async (name) => {
        await Promise.resolve();
        chosen.push(name);
      },
    );
    const ready = defaults.open(true, () => "");
    let settled = false;
    void ready.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    list.resolve([{ name: "Analisi 1" }]);
    await ready;
    expect(chosen).toEqual(["Analisi 1"]);
  });

  it("drops a pending default when the student opens another chat while the subjects load", async () => {
    const list = later<Subjects>();
    const chosen: string[] = [];
    const defaults = newChatDefault(
      () => list.promise,
      async (name) => {
        chosen.push(name);
      },
    );
    const ready = defaults.open(true, () => "");
    // An existing chat without a subject opens on the same Ask page.
    await defaults.open(false, () => "");
    list.resolve([{ name: "Analisi 1" }]);
    await ready;
    expect(chosen).toEqual([]);
  });

  it("reads the subjects again for each new chat", async () => {
    let subjects: Subjects = [{ name: "Analisi 1" }];
    const loads: number[] = [];
    const chosen: string[] = [];
    const defaults = newChatDefault(
      async () => {
        loads.push(subjects.length);
        return subjects;
      },
      async (name) => {
        chosen.push(name);
      },
    );
    await defaults.open(true, () => "");
    subjects = [{ name: "Analisi 1" }, { name: "Fisica" }];
    await defaults.open(true, () => "");
    expect(loads).toEqual([1, 2]);
    expect(chosen).toEqual(["Analisi 1"]);
  });

  it("chooses nothing with several subjects or once the student picked one", async () => {
    const chosen: string[] = [];
    const choose = async (name: string) => {
      chosen.push(name);
    };
    await newChatDefault(async () => [{ name: "Analisi 1" }, { name: "Fisica" }], choose).open(true, () => "");
    await newChatDefault(async () => [{ name: "Analisi 1" }], choose).open(true, () => "Fisica");
    expect(chosen).toEqual([]);
  });
});
