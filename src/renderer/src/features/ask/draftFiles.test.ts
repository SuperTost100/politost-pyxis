import { describe, expect, it } from "vitest";
import type { AttachmentView } from "../../../../shared/ipc";
import { createAttachQueue, createDraftFiles } from "./draftFiles";

function store(entries: Record<string, string> = {}) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

/** Core stand-in: each attach waits for the test to let it go, and answers with a ready file. */
function core() {
  const waiting: Array<{ path: string; draft: string; done: () => void; fail: (error: unknown) => void }> = [];
  let next = 0;
  const attachInCore = (path: string, draft: string) =>
    new Promise<AttachmentView>((resolve, reject) => {
      const id = `f${(next += 1)}`;
      waiting.push({
        path,
        draft,
        done: () => resolve({ id, name: path.split("/").pop()!, kind: "document", size: 1, state: "ready" }),
        fail: reject,
      });
    });
  /** Lets every attach that is waiting, or that comes next, finish. */
  const flush = async () => {
    for (let round = 0; round < 50; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      while (waiting.length) waiting.shift()!.done();
    }
  };
  return { attachInCore, waiting, flush };
}

describe("an attach result applies only to the draft that started it", () => {
  it("lands in the first chat's draft when the student has moved to another chat meanwhile", async () => {
    const session = store();
    const drafts = createDraftFiles(session);
    const { attachInCore, waiting, flush } = core();
    const queue = createAttachQueue(drafts, attachInCore);
    const started = queue.attach("chat-a", ["/x/appunti.pdf"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The student switches to chat B and picks nothing there. The request is still in flight.
    expect(drafts.files.get("chat-b")).toEqual([]);
    waiting[0]!.done();
    await started;
    expect(drafts.files.get("chat-a").map((file) => file.name)).toEqual(["appunti.pdf"]);
    expect(drafts.files.get("chat-b")).toEqual([]);
    // It is kept for the draft in the session too, whether or not any page shows it.
    expect(JSON.parse(session.getItem("pyxis-files:chat-a")!)).toEqual([expect.objectContaining({ name: "appunti.pdf" })]);
    expect(session.getItem("pyxis-files:chat-b")).toBeNull();
    void flush;
  });

  it("keeps a new chat's draft apart from a chat's", async () => {
    const drafts = createDraftFiles(store());
    const { attachInCore, flush } = core();
    const queue = createAttachQueue(drafts, attachInCore);
    const first = queue.attach("", ["/x/uno.pdf"]);
    const second = queue.attach("chat-a", ["/x/due.pdf"]);
    await flush();
    await Promise.all([first, second]);
    expect(drafts.files.get("").map((file) => file.name)).toEqual(["uno.pdf"]);
    expect(drafts.files.get("chat-a").map((file) => file.name)).toEqual(["due.pdf"]);
  });
});

describe("a draft's batches run one after the other", () => {
  it("marks the ninth file as over the limit when it is picked, even from two overlapping batches", async () => {
    const drafts = createDraftFiles(store());
    const { attachInCore, flush } = core();
    const queue = createAttachQueue(drafts, attachInCore);
    const paths = (from: number, count: number) => Array.from({ length: count }, (_, at) => `/x/f${from + at}.pdf`);
    const first = queue.attach("", paths(1, 5));
    const second = queue.attach("", paths(6, 5));
    await flush();
    await Promise.all([first, second]);
    const files = drafts.files.get("");
    const views = drafts.views.get();
    const held = files.filter((file) => !file.id.startsWith("local-"));
    const refused = files.filter((file) => file.id.startsWith("local-"));
    expect(held.map((file) => file.name)).toEqual(Array.from({ length: 8 }, (_, at) => `f${at + 1}.pdf`));
    expect(refused.map((file) => file.name)).toEqual(["f9.pdf", "f10.pdf"]);
    expect(refused.map((file) => views[file.id])).toEqual([
      expect.objectContaining({ state: "failed", error: "too-many" }),
      expect.objectContaining({ state: "failed", error: "too-many" }),
    ]);
  });

  it("does not attach a file that is already in the draft, and does not count a refused chip against the limit", async () => {
    const drafts = createDraftFiles(store());
    const { attachInCore, flush } = core();
    const queue = createAttachQueue(drafts, async (path, draft) => {
      if (path.includes("enorme")) throw { code: "source-too-big" };
      return attachInCore(path, draft);
    });
    const batch = queue.attach("", ["/x/uno.pdf", "/x/uno.pdf", "/x/enorme.pdf"]);
    await flush();
    await batch;
    const files = drafts.files.get("");
    expect(files.map((file) => file.name)).toEqual(["uno.pdf", "enorme.pdf"]);
    expect(drafts.views.get()[files[1]!.id]).toMatchObject({ state: "failed", error: "too-large" });
    // Seven more fit: the refused chip is not one of the eight.
    const more = queue.attach("", Array.from({ length: 7 }, (_, at) => `/x/g${at}.pdf`));
    await flush();
    await more;
    expect(drafts.files.get("").filter((file) => !file.id.startsWith("local-"))).toHaveLength(8);
  });
});

describe("a send waits for the draft's pending registrations", () => {
  it("resolves idle only when every file picked so far has been applied", async () => {
    const drafts = createDraftFiles(store());
    const { attachInCore, waiting } = core();
    const queue = createAttachQueue(drafts, attachInCore);
    void queue.attach("", ["/x/uno.pdf", "/x/due.pdf", "/x/tre.pdf"]);
    expect(queue.busy("")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    let idle = false;
    void queue.idle("").then(() => (idle = true));
    // Enter is pressed while the first file is registered and the others are still to come.
    waiting.shift()!.done();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(idle).toBe(false);
    expect(drafts.files.get("")).toHaveLength(1);
    waiting.shift()!.done();
    await new Promise((resolve) => setTimeout(resolve, 5));
    waiting.shift()!.done();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(idle).toBe(true);
    expect(drafts.files.get("").map((file) => file.name)).toEqual(["uno.pdf", "due.pdf", "tre.pdf"]);
    expect(queue.busy("")).toBe(false);
  });

  it("is idle at once for a draft with nothing queued", async () => {
    const queue = createAttachQueue(createDraftFiles(store()), async () => {
      throw new Error("never");
    });
    await queue.idle("chat-a");
  });
});
