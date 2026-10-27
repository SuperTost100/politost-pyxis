import { describe, expect, it } from "vitest";
import {
  addIds,
  allowsGeneral,
  applySubject,
  choseGeneral,
  newChatSubject,
  onlySubject,
  scopeChanges,
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

/** Whether a promise has settled after the microtasks queued so far have run. */
async function settledNow(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return done;
}

describe("scope changes a question waits for", () => {
  it("holds a question until the new chat's default subject and its sources are chosen", async () => {
    const scope = scopeChanges();
    const chat = scope.open();
    const list = later<Subjects>();
    const chosen: string[] = [];
    scope.track(
      onlySubject(
        () => list.promise,
        () => scope.isCurrent(chat),
        async (name) => {
          await Promise.resolve();
          chosen.push(name);
        },
      ),
    );
    const question = scope.settled();
    expect(await settledNow(question)).toBe(false);
    list.resolve([{ name: "Analisi 1" }]);
    await question;
    expect(chosen).toEqual(["Analisi 1"]);
  });

  it("also waits for a subject the student picks while the default is still loading", async () => {
    const scope = scopeChanges();
    scope.open();
    const list = later<Subjects>();
    scope.track(list.promise);
    const question = scope.settled();
    const picked = later<void>();
    scope.track(picked.promise);
    list.resolve([]);
    expect(await settledNow(question)).toBe(false);
    picked.resolve();
    expect(await settledNow(question)).toBe(true);
  });

  it("releases a question in an existing chat from the new chat's pending default, and drops that default", async () => {
    const scope = scopeChanges();
    const newChat = scope.open();
    const list = later<Subjects>();
    const chosen: string[] = [];
    const pending = scope.track(
      onlySubject(
        () => list.promise,
        () => scope.isCurrent(newChat),
        async (name) => {
          chosen.push(name);
        },
      ),
    );
    // An existing chat without a subject opens on the same Ask page.
    scope.open();
    expect(await settledNow(scope.settled())).toBe(true);
    list.resolve([{ name: "Analisi 1" }]);
    await pending;
    expect(chosen).toEqual([]);
  });

  it("waits for every change still running in the chat, not only the latest", async () => {
    const scope = scopeChanges();
    scope.open();
    const defaultLoad = later<void>();
    const starterPlan = later<void>();
    scope.track(defaultLoad.promise);
    scope.track(starterPlan.promise);
    const question = scope.settled();
    starterPlan.resolve();
    expect(await settledNow(question)).toBe(false);
    defaultLoad.resolve();
    expect(await settledNow(question)).toBe(true);
  });

  it("skips the default once the student chose a subject in this chat, \"No subject\" included", async () => {
    const scope = scopeChanges();
    const chat = scope.open();
    expect(scope.wantsDefault(chat)).toBe(true);
    const list = later<Subjects>();
    const chosen: string[] = [];
    const pending = scope.track(
      onlySubject(
        () => list.promise,
        () => scope.wantsDefault(chat),
        async (name) => {
          chosen.push(name);
        },
      ),
    );
    // "No subject" picked while the list loads: the value stays empty, but it is a choice.
    scope.choose();
    list.resolve([{ name: "Analisi 1" }]);
    await pending;
    expect(chosen).toEqual([]);
    // The next chat starts with no choice made.
    const next = scope.open();
    expect(scope.wantsDefault(next)).toBe(true);
    expect(scope.wantsDefault(chat)).toBe(false);
  });

  it("lets a question go after a change that failed", async () => {
    const scope = scopeChanges();
    scope.open();
    scope.track(Promise.reject(new Error("offline")));
    await expect(scope.settled()).resolves.toBe(true);
  });

  it("tells a question its chat was left while it waited, so it does not go out with another chat's scope", async () => {
    const scope = scopeChanges();
    scope.open();
    const subjectSources = later<void>();
    scope.track(subjectSources.promise);
    const question = scope.settled();
    // The student opens another chat, whose own change is still running.
    scope.open();
    scope.track(new Promise(() => undefined));
    subjectSources.resolve();
    await expect(question).resolves.toBe(false);
  });

  it("chooses nothing with several subjects or once the student picked one", async () => {
    const chosen: string[] = [];
    const choose = async (name: string) => {
      chosen.push(name);
    };
    await onlySubject(async () => [{ name: "Analisi 1" }, { name: "Fisica" }], () => true, choose);
    await onlySubject(async () => [{ name: "Analisi 1" }], () => false, choose);
    expect(chosen).toEqual([]);
  });
});

