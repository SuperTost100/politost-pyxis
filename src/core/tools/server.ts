import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

/**
 * The MCP server through which the model that answers a chat calls Pyxis's tools (`registry.ts`). It is Streamable HTTP
 * with JSON responses only, bound to 127.0.0.1 on a port the system picks, and it starts on the first chat turn that
 * needs it. cli-funnel hands it to Claude Code, Codex and Antigravity at access `none`, where its tools are the only
 * ones the model can call (`TurnInput.tools` in `engine/funnel.ts`).
 *
 * It is written by hand rather than with `@modelcontextprotocol/sdk`: the SDK's HTTP transport brings express, hono, ajv
 * and more (4.5 MB unpacked for the SDK alone), and the five methods below are what the three CLIs use. Its Host check is
 * opt-in there too.
 *
 * Who may call:
 * - Every request needs `Authorization: Bearer <token>`. A chat gets one token (256 random bits) the first time one of
 *   its turns needs tools, and keeps it until the chat is deleted (`revokeChatTools`) or core stops, so the process
 *   cli-funnel keeps between questions is reused: a new token would change the run's settings and restart it. The token
 *   is accepted only while a turn of that chat is running (`armChatTools`), and a call acts only on that chat, so between
 *   questions it opens nothing, whichever CLI process still holds it. A turn answered on Antigravity ends the token too
 *   (`chat/turn.ts`), since agy writes the headers into its conversation store.
 * - The Host header must be this server's own `127.0.0.1:<port>`, and a request that carries an Origin header is refused,
 *   so neither a page in a browser nor a DNS name rebound to 127.0.0.1 can reach it.
 * - At most `MAX_CONNECTIONS` connections are held at once; one more is closed as it opens.
 * - A body is at most `MAX_BODY` bytes of JSON. Each tool validates its arguments with its own Zod schema, and the
 *   number of calls in a turn is capped (`MAX_CALLS_PER_TURN`); each tool caps what one call and one turn may do.
 *
 * Nothing here logs: the token, the URL and the arguments stay out of the log and crash reports.
 */

/** Bytes of request body accepted. Thirty cards of a few thousand characters each fit with room to spare. */
export const MAX_BODY = 512 * 1024;
/** Connections held at once. Any process on the machine can connect, and idle connections must not use up core's files. */
export const MAX_CONNECTIONS = 32;
/** Tool calls one chat turn may make, whatever the tool. */
export const MAX_CALLS_PER_TURN = 4;
/** The MCP revisions this server speaks; it answers with the client's when it knows it, else the newest. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** What a tool sees of the turn that called it. */
export type ToolTurn = {
  readonly chatId: string;
  /** Where the chat's work goes: its exam, else its subject (for a new chat, the one Pyxis picks in this turn), by name. */
  place(): { planId: string | null; subject: string | null };
  /** The engine answering, recorded with what a tool creates. */
  engine(): { provider: string; model: string };
  /** What this turn's calls have done so far, for the tool's own per-turn caps. Tools add to it. */
  readonly tally: Record<string, number>;
  /** The result a tool stored in this turn, by tool, so a later call of the same tool adds to it. Tools set it. */
  readonly kept: Record<string, string>;
  /** The tool started, before its arguments are read: the chat shows its working state. Returns the call's handle. */
  started(tool: string): unknown;
  /** The call ended: a result to show in the chat, or nothing when it failed (the model was told why). */
  finished(call: unknown, shown: ToolShown | null): void;
};

/** A result the chat shows where the tool was called: its stored id. */
export type ToolShown = { resultId: string };

/** What a tool returns: the text the model reads, and for a call that did something, the result the chat shows. */
export type ToolOutcome = { text: string; isError?: boolean; shown?: ToolShown };

export type Tool = {
  name: string;
  description: string;
  input: z.ZodType;
  run(turn: ToolTurn, args: unknown): ToolOutcome | Promise<ToolOutcome>;
};

type Chat = { chatId: string; token: Buffer; armed: { turn: ToolTurn; calls: number } | null };

let server: Server | undefined;
let starting: Promise<number> | undefined;
let port = 0;
let tools: readonly Tool[] = [];
/** The chats with a token, by the SHA-256 of the token, so a lookup reveals nothing about the token's bytes. */
const byDigest = new Map<string, Chat>();
const byChat = new Map<string, Chat>();

const digest = (token: Buffer | string) => createHash("sha256").update(token).digest("hex");

/** The tools the server offers. Core sets them once; tests set their own. */
export function setTools(list: readonly Tool[]): void {
  tools = list;
}

/** The address and bearer token a chat's turns hand to the engine. Starts the server on first use. */
export async function chatTools(chatId: string): Promise<{ url: string; token: string }> {
  const listening = await ensureServer();
  let chat = byChat.get(chatId);
  if (!chat) {
    chat = { chatId, token: randomBytes(32), armed: null };
    byChat.set(chatId, chat);
    byDigest.set(digest(chat.token.toString("base64url")), chat);
  }
  return { url: `http://127.0.0.1:${listening}/mcp`, token: chat.token.toString("base64url") };
}

/**
 * Lets the chat's token act for this turn until the returned function is called. A second turn of the same chat cannot
 * run alongside (`requireIdle` in `chat/turn.ts`), so a later arm replaces an earlier one.
 */
export function armChatTools(turn: ToolTurn): () => void {
  const chat = byChat.get(turn.chatId);
  if (!chat) return () => undefined;
  const armed = { turn, calls: 0 };
  chat.armed = armed;
  return () => {
    if (chat.armed === armed) chat.armed = null;
  };
}

/** The chat's live process ended: its token stops working, and its next turn gets a new one. */
export function revokeChatTools(chatId: string): void {
  const chat = byChat.get(chatId);
  if (!chat) return;
  byChat.delete(chatId);
  byDigest.delete(digest(chat.token.toString("base64url")));
  chat.armed = null;
}

/** Every token stops working and the server stops listening, when core shuts down or in tests. */
export async function stopToolServer(): Promise<void> {
  for (const chatId of [...byChat.keys()]) revokeChatTools(chatId);
  const closing = server;
  server = undefined;
  starting = undefined;
  port = 0;
  if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
}

function ensureServer(): Promise<number> {
  if (server && port) return Promise.resolve(port);
  if (starting) return starting;
  starting = new Promise<number>((resolve, reject) => {
    const created = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => void handle(req, res));
    // A client that opens a connection and sends nothing does not hold it open.
    created.requestTimeout = 60_000;
    created.headersTimeout = 10_000;
    created.maxConnections = MAX_CONNECTIONS;
    created.on("error", (err) => {
      if (!port) {
        starting = undefined;
        reject(err);
      }
    });
    created.listen(0, "127.0.0.1", () => {
      server = created;
      port = (created.address() as AddressInfo).port;
      // The server must not keep core alive on its own when everything else has ended.
      created.unref();
      resolve(port);
    });
  });
  return starting;
}

function reply(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

/** The chat whose token the request carries, compared in constant time, or undefined. */
function caller(req: IncomingMessage): Chat | undefined {
  const header = req.headers.authorization;
  const match = typeof header === "string" ? /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(header) : null;
  if (!match) return undefined;
  const presented = Buffer.from(match[1]!, "utf8");
  const chat = byDigest.get(digest(presented));
  if (!chat) return undefined;
  const expected = Buffer.from(chat.token.toString("base64url"), "utf8");
  return expected.length === presented.length && timingSafeEqual(expected, presented) ? chat : undefined;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // DNS rebinding: a name that resolves to 127.0.0.1 still sends its own Host. Only this server's address is accepted.
    if (req.headers.host !== `127.0.0.1:${port}`) return reply(res, 403, { error: "host" });
    // A page in a browser always sends Origin with a cross-origin POST. The CLIs send none.
    if (req.headers.origin !== undefined) return reply(res, 403, { error: "origin" });
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/mcp") return reply(res, 404, { error: "not-found" });
    const chat = caller(req);
    if (!chat) return reply(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    // No server-to-client stream and no sessions: GET and DELETE are not offered, as Streamable HTTP allows.
    if (req.method !== "POST") return reply(res, 405, { error: "method" }, { allow: "POST" });
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return reply(res, 415, { error: "content-type" });
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY) {
      reply(res, 413, { error: "too-large" }, { connection: "close" });
      req.destroy();
      return;
    }
    const body = await readBody(req);
    if (body === null) {
      reply(res, 413, { error: "too-large" }, { connection: "close" });
      req.destroy();
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return reply(res, 400, rpcError(null, -32700, "Parse error"));
    }
    // Batches left the protocol in 2025-06-18, and no client of Pyxis's sends one.
    if (!message || typeof message !== "object" || Array.isArray(message))
      return reply(res, 400, rpcError(null, -32600, "Invalid Request"));
    const answer = await dispatch(chat, message as Rpc);
    if (answer === undefined) return reply(res, 202);
    reply(res, 200, answer);
  } catch {
    // A failure is told without its details, which could hold a tool's arguments.
    reply(res, 500, rpcError(null, -32603, "Internal error"));
  }
}

/** The request body, or null once it passes `MAX_BODY` bytes. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        over = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

const validId = (id: unknown) => typeof id === "string" || (typeof id === "number" && Number.isFinite(id));

async function dispatch(chat: Chat, message: Rpc): Promise<unknown> {
  const isRequest = "id" in message && message.id !== undefined && message.id !== null;
  // A notification, or a response from the client to a request this server never sends: acknowledged, nothing to answer.
  if (!isRequest) return typeof message.method === "string" || "result" in message || "error" in message ? undefined : rpcError(null, -32600, "Invalid Request");
  const id = message.id;
  if (!validId(id) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return rpcError(validId(id) ? id : null, -32600, "Invalid Request");
  const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
  switch (message.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "pyxis", version: "1" },
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: tools.map(describe) });
    case "tools/call":
      return rpcResult(id, await call(chat, params));
    default:
      // agy opens with `server/discover`, and every unknown method must get this error rather than silence.
      return rpcError(id, -32601, "Method not found");
  }
}

const inputSchemas = new WeakMap<Tool, Record<string, unknown>>();

function describe(tool: Tool) {
  let schema = inputSchemas.get(tool);
  if (!schema) {
    const { $schema: _drop, ...plain } = z.toJSONSchema(tool.input, { target: "draft-7", io: "input" }) as Record<string, unknown>;
    schema = plain;
    inputSchemas.set(tool, schema);
  }
  return { name: tool.name, description: tool.description, inputSchema: schema };
}

const errorResult = (text: string) => ({ content: [{ type: "text", text }], isError: true });

async function call(chat: Chat, params: Record<string, unknown>) {
  const armed = chat.armed;
  // The token is the chat's, but no turn of it is running: nothing may act on the chat between questions.
  if (!armed || armed.turn.chatId !== chat.chatId)
    return errorResult("This tool can only be used while you are answering the student.");
  const { turn } = armed;
  const tool = tools.find((entry) => entry.name === params.name);
  if (!tool) return errorResult("Unknown tool.");
  if (armed.calls >= MAX_CALLS_PER_TURN)
    return errorResult(`No more tool calls in this answer (at most ${MAX_CALLS_PER_TURN}). Finish your answer.`);
  armed.calls += 1;
  const handle = turn.started(tool.name);
  let outcome: ToolOutcome;
  try {
    const parsed = tool.input.safeParse(params.arguments ?? {});
    outcome = parsed.success
      ? await tool.run(turn, parsed.data)
      : { text: `Invalid arguments: ${z.prettifyError(parsed.error).slice(0, 1500)}`, isError: true };
  } catch {
    outcome = { text: "The tool failed. Tell the student it did not work, and do not retry.", isError: true };
  }
  // The turn may have ended while the tool ran (Stop): its result is still stored, and the chat shows it once read.
  turn.finished(handle, outcome.shown ?? null);
  return { content: [{ type: "text", text: outcome.text }], ...(outcome.isError ? { isError: true } : {}) };
}
