import { idleTimeout, readCapped } from "../core/sources/capped-body";
import { blockedAddress, fetchPublicResponse } from "../core/sources/public-fetch";
import { directPlanUrl, httpPlanUrl } from "../shared/plan-file";

// Room for one embedded 200 MiB original as base64 plus the plan. A file this app saves is smaller (MAX_PLAN_FILE_BYTES).
export const MAX_LINKED_PLAN_BYTES = 320 * 1024 * 1024;

/**
 * Downloads a shared plan. It gives up with a TimeoutError when no response or part of the body arrives for `idleMs`,
 * so a large plan on a slow connection can take as long as it needs.
 */
export async function fetchPlanText(
  raw: string,
  request = fetchPublicResponse,
  idleMs = 30_000,
): Promise<string> {
  const idle = idleTimeout(idleMs, new DOMException("No data arrived in time", "TimeoutError"));
  try {
    return await readPlan(raw, request, idle);
  } finally {
    idle.clear();
  }
}

async function readPlan(
  raw: string,
  request: typeof fetchPublicResponse,
  idle: ReturnType<typeof idleTimeout>,
): Promise<string> {
  // A share link from Google Drive, Dropbox or OneDrive is rewritten once; the loop checks it and every redirect.
  let current = directPlanUrl(httpPlanUrl(raw));
  const signal = idle.signal;
  for (let hop = 0; hop <= 5; hop++) {
    if (blockedAddress(new URL(current).hostname)) throw new Error("plan-url");
    // The production transport validates every resolved address and pins the socket.
    const { response, agent } = await request(current, {
      redirect: "manual",
      signal,
    });
    idle.touch();
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
      const bytes = await readCapped(response.body, MAX_LINKED_PLAN_BYTES, () => new Error("plan-too-big"), {
        onPart: idle.touch,
      });
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally {
      await agent.close();
    }
  }
  throw new Error("plan-redirect");
}
