import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftSaver } from "./draftSaver";

describe("draftSaver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves the newest draft once typing pauses", async () => {
    const saved: string[] = [];
    const saver = draftSaver(async (draft: string) => void saved.push(draft), () => undefined, 500);
    saver.schedule("a");
    await vi.advanceTimersByTimeAsync(300);
    saver.schedule("ab");
    await vi.advanceTimersByTimeAsync(300);
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(saved).toEqual(["ab"]);
  });

  it("saves at once on flush, nothing twice, and nothing after cancel", async () => {
    const saved: string[] = [];
    const saver = draftSaver(async (draft: string) => void saved.push(draft), () => undefined, 500);
    saver.schedule("a");
    await saver.flush();
    await saver.flush();
    saver.schedule("b");
    saver.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved).toEqual(["a"]);
  });

  /** A save that stays on its way until the test releases it, and one that fails when the draft is "bad". */
  function slowSaver(onError: () => void = () => undefined) {
    const sent: string[] = [];
    const landed: string[] = [];
    const releases: Array<() => void> = [];
    const saver = draftSaver(
      (draft: string) => {
        sent.push(draft);
        if (draft === "bad") return Promise.reject(new Error("disk full"));
        return new Promise<void>((resolve) =>
          releases.push(() => {
            landed.push(draft);
            resolve();
          }),
        );
      },
      onError,
      500,
    );
    return { saver, sent, landed, release: () => releases.splice(0).forEach((release) => release()) };
  }

  it("goes on after a failed save", async () => {
    const errors: number[] = [];
    const { saver, sent, release } = slowSaver(() => errors.push(1));
    saver.schedule("bad");
    await saver.flush();
    saver.schedule("next");
    const last = saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await last;
    expect(sent).toEqual(["bad", "next"]);
    expect(errors).toEqual([1]);
  });

  it("reports a failed save and keeps its draft, so the next flush sends it again", async () => {
    const sent: string[] = [];
    let failing = true;
    const errors: number[] = [];
    const saver = draftSaver(
      async (draft: string) => {
        sent.push(draft);
        if (failing) throw new Error("disk full");
      },
      () => errors.push(1),
      500,
    );
    saver.schedule("answers");
    expect(await saver.flush()).toBe(false);
    expect(errors).toEqual([1]);
    failing = false;
    expect(await saver.flush()).toBe(true);
    expect(sent).toEqual(["answers", "answers"]);
    // Once saved, nothing is left to send.
    expect(await saver.flush()).toBe(true);
    expect(sent).toEqual(["answers", "answers"]);
  });

  it("drops a failed draft that a newer one replaced, and reports the newer one's save", async () => {
    const sent: string[] = [];
    const saver = draftSaver(
      async (draft: string) => {
        sent.push(draft);
        if (draft === "old") throw new Error("disk full");
      },
      () => undefined,
      500,
    );
    saver.schedule("old");
    const first = saver.flush();
    // "old" is on its way and fails; "new" is typed meanwhile and takes its place.
    await vi.advanceTimersByTimeAsync(0);
    saver.schedule("new");
    expect(await first).toBe(false);
    expect(await saver.flush()).toBe(true);
    expect(sent).toEqual(["old", "new"]);
  });

  it("sends the newest draft when a queued save's turn comes", async () => {
    const { saver, sent, landed, release } = slowSaver();
    saver.schedule("A");
    void saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    saver.schedule("B");
    await vi.advanceTimersByTimeAsync(500);
    saver.schedule("C");
    await vi.advanceTimersByTimeAsync(500);
    release();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual(["A", "C"]);
    expect(landed.at(-1)).toBe("C");
  });

  it("never sends a draft older than one already sent: A on its way, B queued, the page leaves with C", async () => {
    const { saver, sent, landed, release } = slowSaver();
    saver.schedule("A");
    void saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    saver.schedule("B");
    await vi.advanceTimersByTimeAsync(500);
    saver.schedule("C");
    const left = saver.flush(true);
    expect(sent).toEqual(["A", "C"]);
    release();
    await left;
    await vi.advanceTimersByTimeAsync(1000);
    release();
    expect(sent).toEqual(["A", "C"]);
    expect(landed).toEqual(["A", "C"]);
  });

  it("sends a queued draft at once when the page leaves with nothing newer", async () => {
    const { saver, sent, release } = slowSaver();
    saver.schedule("A");
    void saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    saver.schedule("B");
    await vi.advanceTimersByTimeAsync(500);
    const left = saver.flush(true);
    expect(sent).toEqual(["A", "B"]);
    release();
    await left;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual(["A", "B"]);
  });

  it("sends a leaving page's last draft at once, after a save still on its way, so the last state wins", async () => {
    // Avanti and then "Segna per dopo" within the delay, while an earlier save has not come back, and the page leaves.
    const sent: string[] = [];
    const landed: string[] = [];
    const releases: Array<() => void> = [];
    const saver = draftSaver(
      (draft: string) => {
        sent.push(draft);
        return new Promise<void>((resolve) =>
          releases.push(() => {
            landed.push(draft);
            resolve();
          }),
        );
      },
      () => undefined,
      500,
    );
    saver.schedule("typed on question 1");
    void saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["typed on question 1"]);
    saver.schedule("question 2");
    saver.schedule("question 2, marked");
    // Leaving: sent now, not after the save on its way returns, which a page that is going may never see.
    const left = saver.flush(true);
    expect(sent).toEqual(["typed on question 1", "question 2, marked"]);
    releases.forEach((release) => release());
    await left;
    expect(landed.at(-1)).toBe("question 2, marked");
    // Nothing is sent twice, and the timer of the replaced draft sends nothing later.
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual(["typed on question 1", "question 2, marked"]);
  });
});
