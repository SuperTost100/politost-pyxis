import { parentPort, workerData } from "node:worker_threads";
import { env, pipeline } from "@huggingface/transformers";

// SRC-21: inference has no network access, including tokenizer loading.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useFSCache = false;
const input = workerData as { dir: string; texts?: string[] };
const load = () => pipeline("feature-extraction", input.dir, { dtype: "q8", device: "cpu" });
type Extractor = Awaited<ReturnType<typeof load>>;
async function embed(extractor: Extractor, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (const text of texts) {
    const result = await extractor(text, { pooling: "mean", normalize: true });
    vectors.push(Array.from(result.data as Float32Array));
  }
  return vectors;
}

if (input.texts) {
  // One call, one worker. Core uses this when the shared worker below is busy.
  try {
    const extractor = await load();
    const vectors = await embed(extractor, input.texts);
    await extractor.dispose();
    parentPort?.postMessage({ value: vectors });
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : "embed-load" });
  }
} else {
  // Shared worker: the model loads on the first request and stays until core says close.
  let extractor: Promise<Extractor> | undefined;
  parentPort?.on("message", async (message: { id: number; request: { texts: string[] } } | { close: true }) => {
    if ("close" in message) {
      await (await extractor?.catch(() => undefined))?.dispose();
      process.exit(0);
    }
    try {
      extractor ??= load();
      parentPort?.postMessage({ id: message.id, value: await embed(await extractor, message.request.texts) });
    } catch (error) {
      extractor = undefined;
      parentPort?.postMessage({ id: message.id, error: error instanceof Error ? error.message : "embed-load" });
    }
  });
}
