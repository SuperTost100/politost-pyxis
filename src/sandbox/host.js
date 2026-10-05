const BASE = "pyxis-runtime://sandbox/";
const LOAD_TIMEOUT_MS = 30000;
const lanes = new Map();
let nextId = 0;
function lane(kind) {
  let value = lanes.get(kind);
  if (!value) {
    const worker = new Worker(BASE + (kind === "python" ? "python-worker.js" : "check-worker.js"));
    const buffer = typeof SharedArrayBuffer === "function" ? new Uint8Array(new SharedArrayBuffer(1)) : null;
    let abort;
    const ready = new Promise((resolve, reject) => {
      abort = reject;
      const timer = setTimeout(() => reject(new Error("runtime-load-timeout")), LOAD_TIMEOUT_MS);
      worker.addEventListener("message", (event) => { if (event.data?.type === "ready") { clearTimeout(timer); resolve(); } if (event.data?.type === "load-error") { clearTimeout(timer); reject(new Error(String(event.data.error).slice(0, 2000))); } });
      worker.addEventListener("error", () => { clearTimeout(timer); reject(new Error("runtime-worker-error")); }, { once: true });
    });
    ready.catch(() => undefined);
    worker.postMessage({ type: "init", buffer });
    value = { worker, buffer, ready, abort, tail: Promise.resolve() };
    lanes.set(kind, value);
  }
  return value;
}
// Aborting also settles a load that the terminated worker will never finish.
function reset(kind, current) { current.worker.terminate(); current.abort(new Error("runtime-reset")); if (lanes.get(kind) === current) lanes.delete(kind); }
async function execute(kind, payload, timeoutMs) {
  const current = lane(kind);
  const operation = async () => {
    if (lanes.get(kind) !== current) return execute(kind, payload, timeoutMs);
    try { await current.ready; } catch (error) { reset(kind, current); throw error; }
    const id = ++nextId;
    const token = crypto.randomUUID();
    if (current.buffer) current.buffer[0] = 0;
    return new Promise((resolve) => {
      let stdout = "", stderr = "", size = 0, timedOut = false, truncated = false;
      const images = [];
      let ended = false;
      const finish = (check) => {
        if (ended) return;
        ended = true; clearTimeout(interrupt); clearTimeout(kill);
        current.worker.removeEventListener("message", onMessage);
        resolve(kind === "check" ? (check ?? { state: "none", reason: "check-timeout" }) : { stdout, stderr, images, timedOut, truncated });
      };
      const interrupt = setTimeout(() => { timedOut = true; if (current.buffer) current.buffer[0] = 2; }, timeoutMs);
      const kill = setTimeout(() => { timedOut = true; reset(kind, current); finish(); }, timeoutMs + 1000);
      const onMessage = (event) => {
        const data = event.data;
        if (data?.id !== id || ended) return;
        if (data.type === "output") {
          const text = String(data.text ?? "");
          const room = Math.max(0, 200000 - size);
          const encoded = new TextEncoder().encode(text);
          const bounded = new TextDecoder().decode(encoded.slice(0, room), { stream: encoded.length > room });
          size += new TextEncoder().encode(bounded).length;
          if (data.stream === "stderr") stderr += bounded; else stdout += bounded;
          if (encoded.length > room) { truncated = true; reset(kind, current); finish(); }
        } else if (data.type === "image" && typeof data.image === "string" && images.length < 10 && data.image.length <= 7000000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.image)) images.push(data.image);
        else if (data.type === "done" && (kind !== "python" || data.token === token)) {
          // Termination also drops user-installed listeners and asynchronous tasks.
          if (kind === "python") reset(kind, current);
          finish(data.result);
        }
      };
      current.worker.addEventListener("message", onMessage);
      current.worker.postMessage({ type: "run", id, token, payload });
    });
  };
  const result = current.tail.then(operation, operation);
  current.tail = result.catch(() => undefined);
  return result;
}
Object.defineProperty(window, "pyxisRuntime", { value: Object.freeze({
  run: (code, timeoutMs = 10000) => execute("python", code, timeoutMs),
  check: (claim) => execute("check", claim, 10000),
  stop: (kind) => { const current = lanes.get(kind); if (current) reset(kind, current); },
}) });
