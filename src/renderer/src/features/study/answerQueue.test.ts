import { describe, expect, it, vi } from "vitest";
import { createAnswerQueue } from "./answerQueue";

describe("answer queue", () => {
  it("sends each queued pick once, only for blocks in the saved lesson", async () => {
    const queue = createAnswerQueue();
    const saved = queue.add("check-a", 2);
    const missing = queue.add("check-gone", 0);
    const missingResult = missing.catch((error: Error) => error.message);
    const send = vi.fn(async () => ({ pick: 2 }));

    await queue.flush((id) => id === "check-a", send);
    await saved;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("check-a", 2);
    expect(await missingResult).toBe("answer-dropped");
    expect(queue.size).toBe(0);

    // A second flush, as a repeated effect run would make, sends nothing.
    await queue.flush(() => true, send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps the first pick of a block", async () => {
    const queue = createAnswerQueue();
    const first = queue.add("check-a", 1);
    expect(queue.add("check-a", 3)).toBe(first);
    const send = vi.fn(async () => undefined);
    await queue.flush(() => true, send);
    expect(send).toHaveBeenCalledExactlyOnceWith("check-a", 1);
  });

  it("rejects the pick when saving fails, so the reader can answer again", async () => {
    const queue = createAnswerQueue();
    const saved = queue.add("check-a", 0);
    await queue.flush(
      () => true,
      async () => {
        throw new Error("offline");
      },
    );
    await expect(saved).rejects.toThrow("offline");
  });

  it("drops everything on a stop, a failure or a new run, and sends nothing afterwards", async () => {
    const queue = createAnswerQueue();
    const a = queue.add("check-a", 0);
    const b = queue.add("check-b", 1);
    queue.drop();
    await expect(a).rejects.toThrow("answer-dropped");
    await expect(b).rejects.toThrow("answer-dropped");
    const send = vi.fn(async () => undefined);
    await queue.flush(() => true, send);
    expect(send).not.toHaveBeenCalled();
    expect(queue.size).toBe(0);
  });

  it("marks a discarded pick as dropped, not as a failure to save", async () => {
    const queue = createAnswerQueue();
    const reason = (promise: Promise<void>) => promise.catch((error: Error & { dropped?: boolean }) => error);
    const stopped = reason(queue.add("check-a", 0));
    queue.drop();
    expect(await stopped).toMatchObject({ dropped: true });
    const again = queue.add("check-d", 0);
    const missing = queue.add("check-e", 0);
    const fails = queue.add("check-f", 0);
    await queue.flush(
      (id) => id !== "check-e",
      async (id) => {
        if (id === "check-f") throw new Error("offline");
      },
    );
    await again;
    expect(await reason(missing)).toMatchObject({ dropped: true });
    expect(await reason(fails)).not.toHaveProperty("dropped");
  });
});
