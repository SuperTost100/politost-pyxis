/**
 * Why a pick was not sent: the lesson was stopped, failed or replaced. It is not a failure to save, so the reader
 * sees the check unanswered again without an error (`dropped` is how `SmartText` tells the two apart).
 */
function dropped(): Error {
  return Object.assign(new Error("answer-dropped"), { dropped: true });
}

type Entry = {
  pick: number;
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: Error) => void;
};

/**
 * Picks made on a quick check while its lesson is still being written. The lesson has no saved item to answer
 * against until the stream ends, so the picks wait here: `flush` sends each one once and `drop` discards them.
 */
export function createAnswerQueue() {
  const entries = new Map<string, Entry>();

  /** Takes every entry out first, so no pick can be sent twice. */
  function take() {
    const taken = [...entries];
    entries.clear();
    return taken;
  }

  return {
    get size() {
      return entries.size;
    },
    /** Settles when the pick is saved, and rejects if it is dropped or not saved. The first pick of a block stays. */
    add(blockId: string, pick: number): Promise<void> {
      const queued = entries.get(blockId);
      if (queued) return queued.promise;
      let resolve!: () => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      entries.set(blockId, { pick, promise, resolve, reject });
      return promise;
    },
    /** Sends the picks whose block is in the saved lesson; the rest are dropped. */
    async flush(
      accepts: (blockId: string) => boolean,
      send: (blockId: string, pick: number) => Promise<unknown>,
    ) {
      await Promise.all(
        take().map(([blockId, entry]) => {
          if (!accepts(blockId)) {
            entry.reject(dropped());
            return undefined;
          }
          return send(blockId, entry.pick).then(entry.resolve, entry.reject);
        }),
      );
    },
    drop() {
      for (const [, entry] of take()) entry.reject(dropped());
    },
  };
}
