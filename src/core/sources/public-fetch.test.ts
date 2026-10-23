import { expect, it } from "vitest";
import { readCapped } from "./capped-body";

function stream(parts: number[][], onCancel?: () => void): ReadableStream<Uint8Array> {
  const queue = parts.map((part) => new Uint8Array(part));
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
    cancel: () => onCancel?.(),
  });
}

it("reads every part into one exact buffer and counts the parts", async () => {
  let parts = 0;
  const bytes = await readCapped(stream([[1, 2], [3], [4, 5]]), 5, () => new Error("too-big"), {
    onPart: () => (parts += 1),
  });
  expect([...bytes]).toEqual([1, 2, 3, 4, 5]);
  expect(bytes.buffer.byteLength).toBe(5);
  expect(parts).toBe(3);
});

it("stops with the caller's error once the body passes the cap, and releases the stream", async () => {
  let cancelled = false;
  await expect(
    readCapped(stream([[1, 2], [3, 4]], () => (cancelled = true)), 3, () => new Error("too-big")),
  ).rejects.toThrow("too-big");
  expect(cancelled).toBe(true);
});

it("stops before reading on when the signal is aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stopped"));
  await expect(
    readCapped(stream([[1]]), 10, () => new Error("too-big"), { signal: controller.signal }),
  ).rejects.toThrow("stopped");
});
