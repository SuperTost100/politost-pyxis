import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  armChatTools,
  chatTools,
  MAX_BODY,
  MAX_CALLS_PER_TURN,
  revokeChatTools,
  setTools,
  stopToolServer,
  type ToolTurn,
} from "./server";

type Reply = { status: number; body: string; json: () => any };

/** One request to the server, with every header under the test's control (fetch would set Host itself). */
function send(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<Reply> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: options.method ?? "POST",
        headers: { "content-type": "application/json", host: target.host, ...options.headers },
        setHost: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body, json: () => JSON.parse(body) });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const rpc = (method: string, params: unknown = {}, id: number | string = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params });

let calls: Array<{ chatId: string; n: number }> = [];
let shown: Array<{ chatId: string; resultId: string | null }> = [];

function turnFor(chatId: string): ToolTurn {
  return {
    chatId,
    tally: {},
    place: () => ({ planId: null, subject: "Fisica" }),
    engine: () => ({ provider: "claude", model: "test" }),
    started: (tool) => ({ tool }),
    finished: (_call, result) => shown.push({ chatId, resultId: result?.resultId ?? null }),
  };
}

beforeEach(() => {
  calls = [];
  shown = [];
  setTools([
    {
      name: "count",
      description: "Records a number.",
      input: z.object({ n: z.number().int().max(3) }).strict(),
      run(turn, args) {
        const { n } = args as { n: number };
        calls.push({ chatId: turn.chatId, n });
        return { text: `Recorded ${n}.`, shown: { resultId: `r-${n}` } };
      },
    },
  ]);
});

afterEach(async () => {
  await stopToolServer();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("tool server", () => {
  it("listens on the loopback address with a long random token per chat", async () => {
    const a = await chatTools("chat-a");
    const b = await chatTools("chat-b");
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(a.url).toBe(b.url);
    // 32 random bytes in base64url.
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    // The same chat keeps its token, so the live CLI process stays the same between questions.
    expect((await chatTools("chat-a")).token).toBe(a.token);
  });

  it("answers initialize, ping and tools/list, and an unknown method with a JSON-RPC error", async () => {
    const { url, token } = await chatTools("chat-a");
    const init = await send(url, { headers: auth(token), body: rpc("initialize", { protocolVersion: "2025-06-18" }) });
    expect(init.status).toBe(200);
    expect(init.json().result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "pyxis" } });
    const unknownVersion = await send(url, { headers: auth(token), body: rpc("initialize", { protocolVersion: "1999-01-01" }) });
    expect(unknownVersion.json().result.protocolVersion).toBe("2025-11-25");
    expect((await send(url, { headers: auth(token), body: rpc("ping") })).json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const list = (await send(url, { headers: auth(token), body: rpc("tools/list") })).json();
    expect(list.result.tools).toEqual([
      expect.objectContaining({ name: "count", description: "Records a number.", inputSchema: expect.objectContaining({ type: "object" }) }),
    ]);
    expect(list.result.tools[0].inputSchema.$schema).toBeUndefined();
    // agy asks `server/discover` first, and must hear that it is unknown.
    const discover = await send(url, { headers: auth(token), body: rpc("server/discover", {}, 7) });
    expect(discover.status).toBe(200);
    expect(discover.json()).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32601, message: "Method not found" } });
    // A notification is accepted with nothing to answer.
    const note = await send(url, { headers: auth(token), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(note.status).toBe(202);
    expect(note.body).toBe("");
  });

  it("refuses a request without the token, with a wrong one and after the token is revoked", async () => {
    const { url, token } = await chatTools("chat-a");
    expect((await send(url, { body: rpc("tools/list") })).status).toBe(401);
    expect((await send(url, { headers: auth(`${token.slice(0, -1)}A`), body: rpc("tools/list") })).status).toBe(401);
    expect((await send(url, { headers: { authorization: token }, body: rpc("tools/list") })).status).toBe(401);
    expect((await send(url, { headers: { authorization: `Basic ${token}` }, body: rpc("tools/list") })).status).toBe(401);
    // agy sends no Authorization on its GET stream request: refused like any other.
    const get = await send(url, { method: "GET", headers: { accept: "text/event-stream" } });
    expect(get.status).toBe(401);
    expect((await send(url, { method: "GET", headers: auth(token) })).status).toBe(405);
    revokeChatTools("chat-a");
    expect((await send(url, { headers: auth(token), body: rpc("tools/list") })).status).toBe(401);
  });

  it("refuses another Host, any Origin, another path, another content type and a body that is too large", async () => {
    const { url, token } = await chatTools("chat-a");
    const port = new URL(url).port;
    for (const host of [`localhost:${port}`, `evil.example:${port}`, "127.0.0.1", `127.0.0.1:${Number(port) + 1}`])
      expect((await send(url, { headers: { ...auth(token), host }, body: rpc("tools/list") })).status).toBe(403);
    for (const origin of ["http://evil.example", "null", `http://127.0.0.1:${port}`])
      expect((await send(url, { headers: { ...auth(token), origin }, body: rpc("tools/list") })).status).toBe(403);
    expect((await send(url.replace("/mcp", "/other"), { headers: auth(token), body: rpc("tools/list") })).status).toBe(404);
    expect((await send(url, { headers: { ...auth(token), "content-type": "text/plain" }, body: rpc("tools/list") })).status).toBe(415);
    const huge = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(MAX_BODY) } });
    expect((await send(url, { headers: auth(token), body: huge })).status).toBe(413);
    expect((await send(url, { headers: auth(token), body: "{not json" })).status).toBe(400);
    expect((await send(url, { headers: auth(token), body: `[${rpc("tools/list")}]` })).status).toBe(400);
  });

  it("acts only while a turn of the token's own chat runs, and only on that chat", async () => {
    const a = await chatTools("chat-a");
    const b = await chatTools("chat-b");
    const call = (token: string, n: number) =>
      send(a.url, { headers: auth(token), body: rpc("tools/call", { name: "count", arguments: { n } }) }).then((r) => r.json().result);
    // Between questions nothing may act.
    expect(await call(a.token, 1)).toMatchObject({ isError: true });
    expect(calls).toEqual([]);
    // Chat B's turn is running: chat A's token still cannot act, on A or on B.
    const disarmB = armChatTools(turnFor("chat-b"));
    expect(await call(a.token, 1)).toMatchObject({ isError: true });
    expect(calls).toEqual([]);
    // B's own token acts on B.
    expect(await call(b.token, 2)).toEqual({ content: [{ type: "text", text: "Recorded 2." }] });
    expect(calls).toEqual([{ chatId: "chat-b", n: 2 }]);
    expect(shown).toEqual([{ chatId: "chat-b", resultId: "r-2" }]);
    disarmB();
    expect(await call(b.token, 3)).toMatchObject({ isError: true });
    expect(calls).toHaveLength(1);
  });

  it("validates arguments and caps the calls of one turn", async () => {
    const { url, token } = await chatTools("chat-a");
    const call = (args: unknown, name = "count") =>
      send(url, { headers: auth(token), body: rpc("tools/call", { name, arguments: args }) }).then((r) => r.json().result);
    const disarm = armChatTools(turnFor("chat-a"));
    const invalid = await call({ n: 9 });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toMatch(/^Invalid arguments/);
    expect((await call({ n: 1, extra: true })).isError).toBe(true);
    expect((await call({ n: 1 }, "rm_rf")).isError).toBe(true);
    expect(calls).toEqual([]);
    // Failed calls count too: a model cannot retry without end.
    while ((await call({ n: 1 })).isError !== true) void 0;
    expect(calls.length).toBe(MAX_CALLS_PER_TURN - 2);
    expect((await call({ n: 1 })).content[0].text).toMatch(/No more tool calls/);
    disarm();
    // A new turn starts counting again.
    armChatTools(turnFor("chat-a"));
    expect((await call({ n: 1 })).isError).toBeUndefined();
  });

  it("tells a failing tool without its details", async () => {
    setTools([
      {
        name: "boom",
        description: "Fails.",
        input: z.object({}),
        run() {
          throw new Error("secret detail with the arguments");
        },
      },
    ]);
    const { url, token } = await chatTools("chat-a");
    armChatTools(turnFor("chat-a"));
    const result = (await send(url, { headers: auth(token), body: rpc("tools/call", { name: "boom", arguments: {} }) })).json().result;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(shown).toEqual([{ chatId: "chat-a", resultId: null }]);
  });
});
