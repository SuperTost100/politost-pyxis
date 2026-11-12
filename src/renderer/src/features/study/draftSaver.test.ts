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

  it("keeps saves in order and goes on after a failed one", async () => {
    const order: string[] = [];
    const errors: number[] = [];
    let release = () => {};
    const saver = draftSaver(
      (draft: string) => {
        if (draft === "slow")
          return new Promise<void>((resolve) => {
            release = () => {
              order.push(draft);
              resolve();
            };
          });
        if (draft === "bad") return Promise.reject(new Error("disk full"));
        order.push(draft);
        return Promise.resolve();
      },
      () => errors.push(1),
      500,
    );
    saver.schedule("slow");
    void saver.flush();
    saver.schedule("bad");
    void saver.flush();
    saver.schedule("next");
    const last = saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([]);
    release();
    await last;
    expect(order).toEqual(["slow", "next"]);
    expect(errors).toEqual([1]);
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
