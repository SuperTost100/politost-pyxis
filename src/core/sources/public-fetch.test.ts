import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { readCapped } from "./capped-body";
import { fetchPinned } from "./public-fetch";

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

// Runs the real undici, so a release that stops honouring the connector's lookup fails here.
it("connects to the pinned address, not to what the hostname resolves to", async () => {
  const server = createServer((request, response) => response.end(`host=${request.headers.host}`));
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  try {
    const { port } = server.address() as AddressInfo;
    // .invalid never resolves, so only the pinned lookup can reach the server.
    const { agent, response } = await fetchPinned(new URL(`http://pinned.invalid:${port}/`), "127.0.0.1", {});
    try {
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(`host=pinned.invalid:${port}`);
    } finally {
      await agent.close();
    }
  } finally {
    await new Promise((closed) => server.close(closed));
  }
});
