import { expect, it } from "vitest";
import { fetchPlanText, MAX_LINKED_PLAN_BYTES } from "./plan-fetch";

it("follows public relative redirects and accepts plan content above the old 1MB cap", async () => {
  const seen: string[] = [];
  let closed = 0;
  const text = JSON.stringify({ content: "x".repeat(1_100_000) });
  expect(
    await fetchPlanText("https://example.org/release", async (url, init) => {
      seen.push(url);
      expect(init.redirect).toBe("manual");
      return {
        response:
          seen.length === 1
            ? new Response(null, {
                status: 302,
                headers: { location: "/file" },
              })
            : new Response(text),
        agent: {
          close: async () => {
            closed++;
          },
        },
      };
    }),
  ).toBe(text);
  expect(seen).toEqual([
    "https://example.org/release",
    "https://example.org/file",
  ]);
  expect(closed).toBe(2);
});

it("bounds redirects and rejects private targets and oversized responses", async () => {
  for (const location of [
    "http://127.0.0.1/private",
    "https://example.org/loop",
  ]) {
    let requests = 0;
    await expect(
      fetchPlanText("https://example.org/start", async () => {
        requests++;
        return {
          response: new Response(null, { status: 302, headers: { location } }),
          agent: { close: async () => {} },
        };
      }),
    ).rejects.toThrow();
    expect(requests).toBe(location.includes("127.0.0.1") ? 1 : 6);
  }
  await expect(
    fetchPlanText("https://example.org/file", async () => ({
      response: new Response("x", {
        headers: { "content-length": String(MAX_LINKED_PLAN_BYTES + 1) },
      }),
      agent: { close: async () => {} },
    })),
  ).rejects.toThrow("plan-too-big");
});

it("waits for a slow plan as long as data keeps arriving, and gives up when it stops", async () => {
  const text = JSON.stringify({ content: "x".repeat(4096) });
  const bytes = new TextEncoder().encode(text);
  // The body arrives in eight parts 40 ms apart; `stallAfter` parts in, it stops sending.
  const slow = (stallAfter = 8) => async (_url: string, init: RequestInit) => {
    let sent = 0;
    const part = Math.ceil(bytes.length / 8);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal?.addEventListener("abort", () => {
          if (sent < 8) controller.error(init.signal?.reason);
        });
      },
      pull(controller) {
        if (sent === 8) return controller.close();
        if (sent === stallAfter) return new Promise<void>(() => {});
        return new Promise<void>((resolve) =>
          setTimeout(() => {
            controller.enqueue(bytes.subarray(sent * part, (sent + 1) * part));
            sent += 1;
            resolve();
          }, 40),
        );
      },
    });
    return { response: new Response(body), agent: { close: async () => {} } };
  };
  expect(await fetchPlanText("https://example.org/plan", slow(), 120)).toBe(text);
  await expect(fetchPlanText("https://example.org/plan", slow(2), 120)).rejects.toMatchObject({ name: "TimeoutError" });
});
