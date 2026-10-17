import { parentPort } from "node:worker_threads";
import { env, pipeline } from "@huggingface/transformers";

// SRC-21: inference has no network access, including tokenizer loading.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useFSCache = false;
const load = (dir: string) => pipeline("feature-extraction", dir, { dtype: "q8", device: "cpu" });
type Extractor = Awaited<ReturnType<typeof load>>;
/** The vectors, or null when `stop` says to stop before the next text. */
async function embed(extractor: Extractor, texts: string[], stop: () => boolean): Promise<number[][] | null> {
  const vectors: number[][] = [];
  for (const text of texts) {
    if (stop()) return null;
    const result = await extractor(text, { pooling: "mean", normalize: true });
    vectors.push(Array.from(result.data as Float32Array));
  }
  return vectors;
}

// One thread for the life of core. ONNX Runtime can abort the whole process when a thread that loaded it is
// terminated mid-inference, or exits while, or shortly before, another thread loads it (#58). So nothing stops this
// thread: a cancel is a message, and the request stops before its next text; an unload disposes the model, once the
// request before it has finished, to give its memory back, and the next request loads it again.
let model: { dir: string; extractor: Promise<Extractor> } | undefined;
let current: Promise<void> = Promise.resolve();
const cancelled = new Set<number>();
const unload = async () => {
  const loaded = model;
  model = undefined;
  await (await loaded?.extractor.catch(() => undefined))?.dispose();
};
const serve = async (id: number, dir: string, texts: string[]) => {
  try {
    if (model?.dir !== dir) await unload();
    model ??= { dir, extractor: load(dir) };
    const vectors = await embed(await model.extractor, texts, () => cancelled.has(id));
    parentPort?.postMessage(vectors ? { id, value: vectors } : { id, error: "embed-cancelled" });
  } catch (error) {
    await unload().catch(() => undefined);
    parentPort?.postMessage({ id, error: error instanceof Error ? error.message : "embed-load" });
  } finally {
    cancelled.delete(id);
  }
};
parentPort?.on(
  "message",
  (message: { id: number; request: { dir: string; texts: string[] } } | { cancel: number } | { unload: true }) => {
    if ("cancel" in message) cancelled.add(message.cancel);
    else if ("unload" in message) current = current.then(unload).catch(() => undefined);
    else current = current.then(() => serve(message.id, message.request.dir, message.request.texts));
  },
);
