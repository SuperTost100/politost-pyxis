import { blockedAddress, fetchPublicResponse } from "../core/sources/link";
import { httpPlanUrl } from "../shared/plan-file";

// One schema-supported embedded 200 MiB source plus base64 and plan content.
export const MAX_LINKED_PLAN_BYTES = 320 * 1024 * 1024;

export async function fetchPlanText(
  raw: string,
  request = fetchPublicResponse,
): Promise<string> {
  let current = httpPlanUrl(raw);
  const signal = AbortSignal.timeout(30_000);
  for (let hop = 0; hop <= 5; hop++) {
    if (blockedAddress(new URL(current).hostname)) throw new Error("plan-url");
    // The production transport validates every resolved address and pins the socket.
    const { response, agent } = await request(current, {
      redirect: "manual",
      signal,
    });
    try {
      if (response.status >= 300 && response.status < 400) {
        const target = response.headers.get("location");
        await response.body?.cancel();
        if (!target || hop === 5) throw new Error("plan-redirect");
        current = httpPlanUrl(new URL(target, current).toString());
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("plan-download-failed");
      }
      if (
        Number(response.headers.get("content-length")) > MAX_LINKED_PLAN_BYTES
      ) {
        await response.body.cancel();
        throw new Error("plan-too-big");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_LINKED_PLAN_BYTES) {
          await reader.cancel();
          throw new Error("plan-too-big");
        }
        chunks.push(part.value);
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } finally {
      await agent.close();
    }
  }
  throw new Error("plan-redirect");
}
