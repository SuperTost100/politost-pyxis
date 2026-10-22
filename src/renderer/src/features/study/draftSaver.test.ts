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
});
