import type Database from "better-sqlite3";
import { z } from "zod";
import tiers from "../../../resources/model-tiers.json";
import { jsonSchema } from "./generate";
import { getFunnel, runTurn, type ProviderId } from "./funnel";
import type { Gpu, Hardware } from "./hardware";

export type LocalTier = {
  id: string;
  model: string;
  name: string;
  downloadBytes: number;
  contextWindow: number;
  minVramGb: number;
  minUnifiedGb: number;
};
type LocalData = {
  provider: ProviderId;
  installUrl: string;
  minRamGb: number;
  diskMarginGb: number;
  minTokensPerSecond: number;
  strictFeatures: string[];
  tiers: LocalTier[];
};
export const localData = (tiers as unknown as { local: LocalData }).local;
export const LOCAL_PROVIDER = localData.provider;

const GIB = 1024 ** 3;
/** Memory is sold in round sizes, and the system keeps a little for itself: 90% of a size counts as that size. */
const atLeast = (bytes: number, gb: number) => bytes >= gb * GIB * 0.9;

export type LocalReason = "no-gpu" | "vram" | "ram" | "disk" | "unknown";
export type LocalAdvice = {
  /** The model this computer can run, or the one it would run with more free space when `reason` is `disk`. */
  tier: LocalTier | null;
  /** Why no model is suggested. Null when one is. */
  reason: LocalReason | null;
  /** The GPU the advice is based on. */
  gpu: Gpu | null;
};

/**
 * The GPU a model would run on. Ollama uses NVIDIA and AMD cards with their own memory, and Apple Silicon's unified
 * memory. Intel graphics, and any GPU in an Intel Mac, leave the model on the processor, which is too slow.
 */
function usableGpu(hw: Hardware): Gpu | null {
  const candidates = hw.gpus.filter((gpu) =>
    gpu.unified
      ? gpu.vendor === "apple"
      : hw.platform !== "darwin" &&
        (gpu.vendor === "nvidia" || gpu.vendor === "amd") &&
        (gpu.vramBytes ?? 0) > 0,
  );
  return (
    candidates.sort((a, b) => (b.vramBytes ?? 0) - (a.vramBytes ?? 0))[0] ??
    null
  );
}

function fitsMemory(tier: LocalTier, gpu: Gpu): boolean {
  return gpu.unified
    ? atLeast(gpu.vramBytes ?? 0, tier.minUnifiedGb)
    : atLeast(gpu.vramBytes ?? 0, tier.minVramGb);
}

function fitsDisk(
  tier: LocalTier,
  hw: Hardware,
  downloaded: readonly string[],
): boolean {
  if (downloaded.includes(tier.model) || hw.freeDiskBytes == null) return true;
  return hw.freeDiskBytes >= tier.downloadBytes + localData.diskMarginGb * 1e9;
}

/**
 * Picks the largest model in `resources/model-tiers.json` that this computer runs at a usable speed: it must fit in
 * the GPU's memory with room for the context, the computer needs enough RAM, and the disk enough free space (unless
 * Ollama already has the model). Pure, so each hardware class is tested.
 */
export function adviseLocal(
  hw: Hardware,
  downloaded: readonly string[] = [],
): LocalAdvice {
  const gpu = usableGpu(hw);
  if (!gpu)
    return {
      tier: null,
      reason: hw.complete || hw.gpus.length ? "no-gpu" : "unknown",
      gpu: null,
    };
  if (!atLeast(hw.ramBytes, localData.minRamGb))
    return { tier: null, reason: "ram", gpu };
  const fitting = localData.tiers.filter((tier) => fitsMemory(tier, gpu));
  if (!fitting.length) return { tier: null, reason: "vram", gpu };
  // With too little free space a smaller model may still fit; otherwise say how much the best one needs.
  const tier = fitting.find((candidate) => fitsDisk(candidate, hw, downloaded));
  return tier
    ? { tier, reason: null, gpu }
    : { tier: fitting[0]!, reason: "disk", gpu };
}

export function tierOf(model: string): LocalTier | undefined {
  return localData.tiers.find((tier) => tier.model === model);
}

/** Version of the check prompts below. A new version asks for the check again. */
const LOCAL_CHECK_VERSION = 1;

export type LocalCheck = {
  version: number;
  model: string;
  tokensPerSecond: number;
  structured: boolean;
  passed: boolean;
  at: number;
  /** Why it did not pass. */
  failure?: "slow" | "structured" | "error";
};

export type LocalSettings = {
  model: string;
  /** The student wants Pyxis to use the local model. Only true while the last check passed. */
  enabled: boolean;
  check?: LocalCheck;
};

const SETTINGS_KEY = "local-model";

export function readLocal(db: Database.Database): LocalSettings | undefined {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key = ?")
    .get(SETTINGS_KEY) as { value_json: string } | undefined;
  return row ? (JSON.parse(row.value_json) as LocalSettings) : undefined;
}

export function writeLocal(db: Database.Database, value: LocalSettings): void {
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)",
  ).run(SETTINGS_KEY, JSON.stringify(value), Date.now());
}

/** True when the local model may take tasks: the student turned it on and the current check passed. */
export function localUsable(settings: LocalSettings | undefined): boolean {
  return Boolean(
    settings?.enabled &&
    settings.check?.passed &&
    settings.check.version === LOCAL_CHECK_VERSION &&
    settings.check.model === settings.model,
  );
}

const SPEED_PROMPT =
  "Explain in about 150 words, for a university student revising for an exam, how a bill becomes a law in a parliament with two chambers.";

const CHECK_PASSAGE =
  "Photosynthesis takes place in the chloroplasts. Light energy splits water molecules, releasing oxygen, and the energy is stored in ATP and NADPH. In the Calvin cycle these molecules fix carbon dioxide into sugars.";

/** The same kind of answer Pyxis asks for in quizzes: a fixed shape with no extra fields. */
const checkSchema = z.object({
  question: z.string().min(10),
  options: z
    .array(z.string().min(1))
    .length(4)
    .refine((options) => new Set(options).size === 4),
  answer: z.number().int().min(0).max(3),
  explanation: z.string().min(10),
});

const STRUCTURED_PROMPT = `Passage:\n${CHECK_PASSAGE}\n\nWrite one multiple-choice question about the passage with four different options. "answer" is the index (0 to 3) of the correct option. Explain the answer in one sentence.`;

/** Time for the first answer, which includes loading the model from disk into memory. */
const SPEED_TIMEOUT_MS = 180_000;
const STRUCTURED_TIMEOUT_MS = 120_000;

function within(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * The short check after a download: one written answer timed in tokens per second, then one structured answer that
 * must match `checkSchema` on the first try, without the repair turns `generate()` allows. Pyxis's plans, grading and
 * quizzes all depend on that. Passes when both hold. A cancelled check throws; a timed-out one fails as slow.
 */
export async function checkLocalModel(
  model: string,
  options: {
    signal?: AbortSignal;
    run?: typeof runTurn;
    now?: () => number;
  } = {},
): Promise<LocalCheck> {
  const run = options.run ?? runTurn;
  const now = options.now ?? (() => performance.now());
  const selection = { provider: LOCAL_PROVIDER, model };
  const result = (fields: Partial<LocalCheck>): LocalCheck => ({
    version: LOCAL_CHECK_VERSION,
    model,
    tokensPerSecond: 0,
    structured: false,
    passed: false,
    at: Date.now(),
    ...fields,
  });
  let tokensPerSecond = 0;
  try {
    let first: number | undefined;
    const answer = await run({
      selection,
      prompt: SPEED_PROMPT,
      signal: within(options.signal, SPEED_TIMEOUT_MS),
      onDelta: () => {
        first ??= now();
      },
    });
    const end = now();
    // Ollama reports the tokens it wrote. Without that, about four characters make a token.
    const tokens = answer.outputTokens || Math.round(answer.text.length / 4);
    // Timed from the first token, so loading the model and reading the prompt do not count.
    // At least a millisecond, so a reply that arrives in one piece still gets a finite speed.
    const seconds = Math.max(end - (first ?? end), 1) / 1000;
    tokensPerSecond = Math.max(0, tokens - 1) / seconds;
  } catch (err) {
    if (options.signal?.aborted) throw err;
    return result({ failure: timedOut(err) ? "slow" : "error" });
  }
  tokensPerSecond = Math.round(tokensPerSecond * 10) / 10;
  let structured = false;
  let structuredTimedOut = false;
  try {
    const reply = await run({
      selection,
      prompt: STRUCTURED_PROMPT,
      responseSchema: {
        name: "quiz_question",
        schema: jsonSchema(checkSchema),
      },
      signal: within(options.signal, STRUCTURED_TIMEOUT_MS),
    });
    structured = checkSchema.safeParse(
      reply.structured ?? json(reply.text),
    ).success;
  } catch (err) {
    if (options.signal?.aborted) throw err;
    if (!timedOut(err)) return result({ tokensPerSecond, failure: "error" });
    structuredTimedOut = true;
  }
  const fast = tokensPerSecond >= localData.minTokensPerSecond;
  return result({
    tokensPerSecond,
    structured,
    passed: fast && structured,
    ...(!fast || structuredTimedOut
      ? { failure: "slow" as const }
      : !structured
        ? { failure: "structured" as const }
        : {}),
  });
}

function timedOut(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" ||
      err.name === "AbortError" ||
      /timed? ?out/i.test(err.message))
  );
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export type PullProgress = {
  status: string;
  completed: number;
  total: number;
};

/**
 * Downloads a model through Ollama's pull API. Ollama sends progress per layer; the sum is shown against at least the
 * size the tier table lists, so the bar does not jump back when a later layer starts. Aborting stops the download;
 * Ollama keeps the finished part and resumes it next time.
 */
export async function pullLocalModel(
  model: string,
  options: {
    signal: AbortSignal;
    onProgress?: (progress: PullProgress) => void;
  },
): Promise<void> {
  const expected = tierOf(model)?.downloadBytes ?? 0;
  const layers = new Map<string, { completed: number; total: number }>();
  for await (const event of getFunnel().pullModel(LOCAL_PROVIDER, model, {
    signal: options.signal,
  })) {
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "done") return;
    if (event.digest && event.total)
      layers.set(event.digest, {
        completed: event.completed ?? 0,
        total: event.total,
      });
    let completed = 0;
    let total = 0;
    for (const layer of layers.values()) {
      completed += layer.completed;
      total += layer.total;
    }
    options.onProgress?.({
      status: event.status,
      completed,
      total: Math.max(total, expected),
    });
  }
  options.signal.throwIfAborted();
  throw new Error("Ollama ended the download before it finished.");
}
