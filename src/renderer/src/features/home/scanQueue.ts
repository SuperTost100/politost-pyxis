// Scans of one source run one after another, even when the Library was left and opened again meanwhile. A scan that is
// still stopping then cannot send its `ocrStop` into the one that replaced it.
const tails = new Map<string, Promise<void>>();

export function afterEarlierScans<T>(
  sourceId: string,
  run: () => Promise<T>,
): Promise<T> {
  const turn = (tails.get(sourceId) ?? Promise.resolve()).then(run);
  const tail = turn.then(
    () => undefined,
    () => undefined,
  );
  tails.set(sourceId, tail);
  void tail.then(() => {
    if (tails.get(sourceId) === tail) tails.delete(sourceId);
  });
  return turn;
}
