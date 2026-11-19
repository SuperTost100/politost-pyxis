// Runs the fixed conversations of tests/fixtures/chat-conversations.json through a real tool and says which replies do
// what each conversation's rule asks. It makes real model calls on the student's subscriptions, so it is run by hand and
// is not part of the tests or CI. Usage: node scripts/judge-chat.mjs <claude|codex|agent|antigravity> [fast|mid] [id,id,...]
// `print <id>` shows what would be sent for one conversation without calling a model, and `rejudge <file>` judges saved replies again. Replies are written to .tmp/judge-chat-<tool>-<tier>.json, which is not committed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createFunnel } from "cli-funnel";
import { chatSystemPrompt, contextBlock } from "../src/core/chat/prompts";
import { figureKinds } from "../src/shared/figure-kinds";

type Conversation = {
  id: string;
  language: "it" | "en";
  history: Array<{ role: "user" | "assistant"; text: string }>;
  message: string;
  rule: string;
  must?: string[];
  mustNot?: string[];
  mustFormula?: string[];
  mustNotFormula?: string[];
  minWords?: number;
  maxWords?: number;
  endsWithQuestion?: boolean;
  followups?: "solution" | "similar";
  material?: boolean;
};

/** The fast and the middle model of each tool, which a Gemini and a Cursor run take from the Gemini and Grok families. */
const MODELS: Record<string, { fast: [string, string]; mid: [string, string] }> = {
  claude: { fast: ["claude-haiku-5-5", "low"], mid: ["claude-sonnet-5-5", "medium"] },
  codex: { fast: ["gpt-6-luna", "low"], mid: ["gpt-6.1-terra", "medium"] },
  agent: { fast: ["cursor-grok-4.5", "low"], mid: ["grok-4.7", "medium"] },
  antigravity: { fast: ["gemini-3.8-flash", "low"], mid: ["gemini-4-argon", "low"] },
};

const PASSAGE =
  "Il teorema di Weierstrass afferma che una funzione continua su un intervallo chiuso e limitato ha un massimo e un minimo.";

/** The message the chat sends for a new session: the context block, the earlier turns, the passages and the question. */
function messageFor(conv: Conversation): string {
  const header = `${contextBlock({
    language: conv.language === "it" ? "Italian" : "English",
    planLine: "",
    subject: "",
    profile: "Level: university.",
    followups: true,
    figures: [],
  })}\nPinned context: none.`;
  const earlier = conv.history.length
    ? `Earlier turns:\n${conv.history.map((m) => `${m.role}: ${m.text}`).join("\n")}\n\n`
    : "";
  const passages = conv.material ? `<passages>\n[P1] §1\n${PASSAGE}\n</passages>` : "";
  return `${header}\n\n${earlier}${passages}\n\nQuestion:\n${conv.message}`;
}

const squash = (text: string) => text.replace(/[\s\\{}$*`]/g, "");
function judge(conv: Conversation, reply: string) {
  const body = reply.replace(/<followups>[\s\S]*$/i, "").trim();
  const followups = (/<followups>([\s\S]*?)(?:<\/followups>|$)/i.exec(reply)?.[1] ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  const squashed = squash(body);
  const fails: string[] = [];
  for (const pattern of conv.must ?? []) if (!new RegExp(pattern).test(body)) fails.push(`missing ${pattern}`);
  for (const pattern of conv.mustNot ?? []) if (new RegExp(pattern).test(body)) fails.push(`has ${pattern}`);
  for (const pattern of conv.mustFormula ?? []) if (!new RegExp(pattern).test(squashed)) fails.push(`missing ${pattern}`);
  for (const pattern of conv.mustNotFormula ?? []) if (new RegExp(pattern).test(squashed)) fails.push(`has ${pattern}`);
  const words = body.split(/\s+/).filter(Boolean).length;
  if (conv.minWords && words < conv.minWords) fails.push(`only ${words} words`);
  if (conv.maxWords && words > conv.maxWords) fails.push(`${words} words, over ${conv.maxWords}`);
  if (conv.endsWithQuestion && !/\?\s*$/.test(body)) fails.push("does not end with a question");
  if (followups.length !== 3) fails.push(`${followups.length} follow-ups`);
  if (conv.followups === "solution" && !followups.some((line) => /soluzion|solution|complet|full|answer/i.test(line)))
    fails.push("no follow-up asks for the solution");
  if (conv.followups === "similar" && !followups.some((line) => /simil|altr[oa]|another|analog|esercizi|exercise|practice|prova/i.test(line)))
    fails.push("no follow-up asks for a similar exercise");
  return { fails, words };
}

const [tool = "", tier = "fast", only] = process.argv.slice(2);
if (tool === "print") {
  // Prints what would be sent for one conversation, with no model call.
  const all = (JSON.parse(readFileSync("tests/fixtures/chat-conversations.json", "utf8")) as { conversations: Conversation[] }).conversations;
  const conv = all.find((item) => item.id === tier);
  console.log(conv ? `--- system\n${chatSystemPrompt()}\n--- message\n${messageFor(conv)}` : `No conversation ${tier}`);
  process.exit(0);
}
if (tool === "rejudge") {
  // Judges replies saved by an earlier run again, for example after a rule changed: rejudge <file> (a run's json).
  const all = (JSON.parse(readFileSync("tests/fixtures/chat-conversations.json", "utf8")) as { conversations: Conversation[] }).conversations;
  const saved = JSON.parse(readFileSync(tier, "utf8")) as { results: Array<{ id: string; reply: string }> } | Array<{ id: string; reply: string }>;
  for (const item of Array.isArray(saved) ? saved : saved.results) {
    const conv = all.find((candidate) => candidate.id === item.id);
    if (!conv || !item.reply) continue;
    const { fails } = judge(conv, item.reply);
    console.log(item.id.padEnd(22), fails.length ? `FAIL ${fails.join("; ")}` : "PASS");
  }
  process.exit(0);
}
const models = MODELS[tool];
if (!models || (tier !== "fast" && tier !== "mid")) {
  console.error("Usage: node scripts/judge-chat.mjs <claude|codex|agent|antigravity> [fast|mid] [id,id,...] | print <id>");
  process.exit(1);
}
const [model, effort] = models[tier];
const conversations = (JSON.parse(readFileSync("tests/fixtures/chat-conversations.json", "utf8")) as {
  conversations: Conversation[];
}).conversations.filter((conv) => !only || only.split(",").includes(conv.id));
const system = chatSystemPrompt();
const cwd = `.tmp/judge-chat-${tool}`;
mkdirSync(cwd, { recursive: true });
const funnel = createFunnel({});
const results = [];
for (const conv of conversations) {
  const started = Date.now();
  let first = 0;
  let text = "";
  const stream = funnel.stream({
    selection: { provider: tool as never, model, effort, cwd: `${process.cwd()}/${cwd}`, access: "none" },
    prompt: messageFor(conv),
    system,
  });
  for await (const event of stream) if (event.type === "text.delta") (first ||= Date.now() - started), (text += event.text);
  const reply = (await stream.result).text || text;
  const { fails, words } = judge(conv, reply);
  results.push({ id: conv.id, pass: fails.length === 0, fails, words, firstMs: first, totalMs: Date.now() - started, reply });
  console.log(tool, tier, conv.id.padEnd(22), fails.length ? `FAIL ${fails.join("; ")}` : "PASS", `${Date.now() - started} ms`);
}
writeFileSync(`.tmp/judge-chat-${tool}-${tier}.json`, JSON.stringify({ model, results }, null, 2));
void figureKinds;
