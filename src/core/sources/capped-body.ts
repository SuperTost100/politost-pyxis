// Plain stream helpers, apart from public-fetch.ts so a module that only reads a body does not load undici.

/**
 * An abort that fires when nothing arrives for `ms`. `touch` restarts the wait: call it on each response and each part of
 * a body, so a large file on a slow connection takes as long as it needs and a stalled one still ends, as `books.ts` does.
 */
export function idleTimeout(
  ms: number,
  reason?: unknown,
): { signal: AbortSignal; touch: () => void; clear: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(reason), ms);
  };
  touch();
  return { signal: controller.signal, touch, clear: () => clearTimeout(timer) };
}

/**
 * Reads a response body into memory, stopping with `tooBig()` as soon as it passes `max` bytes, before that part is
 * kept. `onPart` runs as each part arrives (an idle timer's `touch`), and `signal` is checked before each read. The
 * reader is released however the read ends. The result has its own buffer of exactly its size.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array>,
  max: number,
  tooBig: () => Error,
  options: { onPart?: () => void; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      options.onPart?.();
      size += value.byteLength;
      if (size > max) throw tooBig();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
