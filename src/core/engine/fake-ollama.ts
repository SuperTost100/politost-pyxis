import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for Ollama's HTTP API, for unit and end-to-end tests: version, model list, a streamed chat and a streamed
 * pull. Nothing leaves the machine and no model runs. Each chat answer is one scripted reply.
 */
export type FakeOllamaOptions = {
  version?: string;
  /** Models the server already has. A finished pull adds its model. */
  models?: string[];
  /** Answers to `/api/chat`, in order; the last one repeats. */
  replies?: Array<{
    text: string;
    /** Tokens the reply reports in `eval_count`. */
    tokens?: number;
    /** Pause between the streamed pieces, so the speed can be measured. */
    delayMs?: number;
  }>;
  /** Bytes of the model layer a pull reports, and how many progress lines it sends. */
  pull?: { bytes: number; steps: number; delayMs?: number; error?: string };
  /** Listen on this port instead of a free one, for a test that starts "Ollama" after the app looked for it. */
  port?: number;
};

export type FakeOllama = {
  url: string;
  requests: Array<{ path: string; body: unknown }>;
  close: () => Promise<void>;
};

async function body(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startFakeOllama(
  options: FakeOllamaOptions = {},
): Promise<FakeOllama> {
  const models = new Set(options.models ?? []);
  const replies = options.replies ?? [{ text: "ok", tokens: 1 }];
  let replyIndex = 0;
  const requests: FakeOllama["requests"] = [];
  const server: Server = createServer(async (request, response) => {
    const path = request.url ?? "";
    const payload = request.method === "POST" ? await body(request) : undefined;
    requests.push({ path, body: payload });
    const json = (value: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (path === "/api/version")
      return json({ version: options.version ?? "0.12.0" });
    if (path === "/api/tags")
      return json({
        models: [...models].map((name) => ({
          name,
          digest: "0123456789abcdef",
          capabilities: ["completion", "vision"],
          details: { family: "gemma3", context_length: 131072 },
        })),
      });
    if (path !== "/api/chat" && path !== "/api/pull") {
      response.writeHead(404);
      return response.end();
    }
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    let closed = false;
    response.on("close", () => {
      closed = true;
    });
    const line = (value: unknown) => {
      if (!closed) response.write(`${JSON.stringify(value)}\n`);
    };
    if (path === "/api/chat") {
      const reply = replies[Math.min(replyIndex++, replies.length - 1)]!;
      const words = reply.text.match(/\S+\s*/g) ?? [reply.text];
      for (const word of words) {
        if (closed) return;
        line({ message: { role: "assistant", content: word }, done: false });
        if (reply.delayMs) await wait(reply.delayMs);
      }
      line({
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 40,
        eval_count: reply.tokens ?? words.length,
      });
      return response.end();
    }
    if (path === "/api/pull") {
      const pull = options.pull ?? { bytes: 1000, steps: 4 };
      const model = (payload as { model?: string } | undefined)?.model ?? "";
      line({ status: "pulling manifest" });
      if (pull.error) {
        line({ error: pull.error });
        return response.end();
      }
      for (let step = 1; step <= pull.steps; step++) {
        if (closed) return;
        line({
          status: "pulling aaaa",
          digest: "sha256:aaaa",
          total: pull.bytes,
          completed: Math.round((pull.bytes * step) / pull.steps),
        });
        if (pull.delayMs) await wait(pull.delayMs);
      }
      line({
        status: "pulling bbbb",
        digest: "sha256:bbbb",
        total: 100,
        completed: 100,
      });
      line({ status: "verifying sha256 digest" });
      line({ status: "writing manifest" });
      models.add(model);
      line({ status: "success" });
      return response.end();
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, "127.0.0.1", resolve),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
