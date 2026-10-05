// Diagnostic only (scripts/repro-core-sequence.mjs --stop=exit): runs the extract worker unchanged, then stops its own thread
// with process.exit(0) a moment after its answer, so the worker ends by itself instead of through `worker.terminate()`.
import { parentPort } from "node:worker_threads";
import { pathToFileURL } from "node:url";

const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (message, ...rest) => {
  post(message, ...rest);
  setTimeout(() => process.exit(0), 50);
};
await import(pathToFileURL(process.env.PYXIS_REPRO_WORKER).href);
