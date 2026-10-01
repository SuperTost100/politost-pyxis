import { parentPort, workerData } from "node:worker_threads";
import { env, pipeline } from "@huggingface/transformers";

// SRC-21: inference has no network access, including tokenizer loading.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useFSCache = false;
const input = workerData as { dir: string; texts: string[] };
try {
  const extractor = await pipeline("feature-extraction", input.dir, { dtype: "q8", device: "cpu" });
  const vectors: number[][] = [];
  for (const text of input.texts) {
    const result = await extractor(text, { pooling: "mean", normalize: true });
    vectors.push(Array.from(result.data as Float32Array));
  }
  await extractor.dispose();
  parentPort?.postMessage({ value: vectors });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : "embed-load" });
}
