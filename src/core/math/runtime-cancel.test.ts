import { beforeEach, expect, it, vi } from "vitest";

const main = vi.hoisted(() => ({
  requests: [] as Array<{ operation: string; payload: unknown }>,
  answer: (_operation: string): unknown => ({}),
}));
vi.mock("./runtime-client", () => ({
  runtimeRequest: async (operation: string, payload: unknown) => {
    main.requests.push({ operation, payload });
    const answer = main.answer(operation);
    if (answer instanceof Error) throw answer;
    return answer;
  },
}));

import type { Runner } from "../jobs/runner";
import { registerRuntimeJob, toolHandlers } from "./handlers";

beforeEach(() => {
  main.requests.length = 0;
  main.answer = () => ({});
});

it("stops the download of the pack it names, or of every pack when it names none", async () => {
  const tools = toolHandlers("");
  await tools.runtimeCancel({ pack: "drawing" });
  await tools.runtimeCancel({});
  expect(main.requests).toEqual([
    { operation: "cancel-download", payload: { packs: ["drawing"] } },
    { operation: "cancel-download", payload: { packs: undefined } },
  ]);
});

/** The download step of each job kind, as the runner would run it. */
function steps() {
  const kinds = new Map<string, { run: (ctx: { signal: AbortSignal; params: unknown }) => Promise<unknown> }>();
  registerRuntimeJob({
    register: (kind: string, spec: { steps: Array<{ run: never }> }) => kinds.set(kind, spec.steps[0] as never),
  } as unknown as Runner);
  return kinds;
}

it("downloads the packs the job names, and ends as cancelled when main says a pack was stopped on its own row", async () => {
  const kinds = steps();
  await kinds.get("local-drawings-download")!.run({ signal: new AbortController().signal, params: undefined });
  await kinds.get("local-runtime-download")!.run({ signal: new AbortController().signal, params: { packs: ["pyodide"] } });
  await kinds.get("local-runtime-download")!.run({ signal: new AbortController().signal, params: undefined });
  expect(main.requests.map((request) => request.payload)).toEqual([{ packs: ["drawing"] }, { packs: ["pyodide"] }, { packs: undefined }]);
  // Stopped from its own row: the job is cancelled (an AbortError, which the runner reads as cancelled), not failed.
  main.answer = () => new Error("runtime-download-cancelled");
  await expect(
    kinds.get("local-drawings-download")!.run({ signal: new AbortController().signal, params: undefined }),
  ).rejects.toMatchObject({ name: "AbortError" });
  // Any other failure stays what it was.
  main.answer = () => new Error("runtime-download-503");
  await expect(
    kinds.get("local-drawings-download")!.run({ signal: new AbortController().signal, params: undefined }),
  ).rejects.toThrow("runtime-download-503");
});
