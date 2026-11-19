import type { Page } from "@playwright/test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { seedPlan, seedSource, seedSubjects } from "./seed";

/** The AI tools a test can stand in for, by the id Pyxis knows them by. */
export type ToolId = "claude" | "codex" | "agent" | "antigravity";

/**
 * Stand-ins for the AI tools' programs: shell scripts that report a version, a signed-in account and, where the real
 * program lists them, its models. They never answer a prompt; a test that needs answers adds the recorded replies.
 * `signedIn` are the tools that say they are signed in; the others are not installed. The folder is also the home of
 * the app under test, so the tools installed on this computer stay hidden. Returns the folder to delete afterwards.
 */
export function standInTools(signedIn: readonly ToolId[]): { bin: string; env: Record<string, string> } {
  const bin = mkdtempSync(join(tmpdir(), "pyxis-tools-bin-"));
  const fake = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const bodies: Record<ToolId, [variable: string, name: string, body: string]> = {
    claude: [
      "CLI_FUNNEL_CLAUDE_BIN",
      "claude",
      `case "$1" in --version) echo "2.1.0";; auth) echo '{"loggedIn":true,"authMethod":"claude.ai"}';; *) exit 1;; esac`,
    ],
    codex: [
      "CLI_FUNNEL_CODEX_BIN",
      "codex",
      `case "$1" in --version) echo "codex-cli 0.150.0";; login) echo "Logged in using ChatGPT";; *) exit 1;; esac`,
    ],
    agent: [
      "CLI_FUNNEL_AGENT_BIN",
      "agent",
      `case "$1" in
  --version) echo "2026.09.28-64d2043";;
  status) echo '{"isAuthenticated":true}';;
  about) echo '{}';;
  --list-models) printf 'grok-4.7-low - Grok 4.7  Low\\ngrok-4.7-high - Grok 4.7  High\\ncursor-grok-4.6-low - Grok 4.6 Low\\ncursor-grok-4.6-high - Grok 4.6\\ngemini-3.8-flash - Gemini 3.8 Flash\\nclaude-sonnet-5-5 - Claude Sonnet 5.5\\nclaude-opus-5-5 - Claude Opus 5.5\\n';;
  *) exit 1;;
esac`,
    ],
    antigravity: [
      "CLI_FUNNEL_AGY_BIN",
      "agy",
      `case "$1" in
  --version) echo "1.3.0";;
  models) printf 'gemini-3.8-flash\\tGemini 3.8 Flash\\ngemini-3.1-pro\\tGemini 3.1 Pro\\n';;
  *) exit 1;;
esac`,
    ],
  };
  const env: Record<string, string> = {
    HOME: bin,
    PATH: "/usr/bin:/bin",
    CLI_FUNNEL_NO_SHELL_PATH: "1",
  };
  for (const id of Object.keys(bodies) as ToolId[]) {
    const [variable, name, body] = bodies[id];
    env[variable] = signedIn.includes(id) ? fake(name, body) : join(bin, `${name}-not-installed`);
  }
  // Antigravity counts as signed in with a Gemini key and a model list.
  if (signedIn.includes("antigravity")) env.GEMINI_API_KEY = "test-key";
  return { bin, env };
}

/**
 * Confirms what the tools receive, so no notice covers the page, and waits until Pyxis has planned with all of them:
 * a task run before that would find no tool.
 */
export async function useTools(page: Page, tools: readonly ToolId[]): Promise<void> {
  await page.evaluate(async (providers) => {
    await window.pyxis.invoke("engines.acknowledge", { providers });
    for (;;) {
      const { ready } = (await window.pyxis.invoke("engines.autoConfigure", {})) as { ready: string[] };
      if (providers.every((id) => ready.includes(id))) return;
      await new Promise((done) => setTimeout(done, 200));
    }
  }, [...tools]);
}

/** The flashcard a recorded tool writes for a topic of `seedChimica`: one card on the topic's one passage. */
export const RECORDED_CARDS = [
  {
    kind: "qa",
    front: "Che cosa mettono in comune due atomi in un legame?",
    back: "Una coppia di elettroni.",
    passageId: "{{passage:0}}",
  },
];

/**
 * An exam of Chimica with two topics that have one book passage each and no flashcards yet, so `study.cardsGenerate` on either
 * one starts a flashcard job. The app has to be running: it made the database.
 */
export function seedChimica(userData: string): void {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  try {
    seedSubjects(db, [{ id: "chim", name: "Chimica" }]);
    seedSource(db, {
      id: "atkins",
      subjectId: "chim",
      title: "Chimica generale",
      document: { id: "d-atkins" },
      passages: [
        { id: "pc0", text: "Un legame covalente si forma quando due atomi mettono in comune una coppia di elettroni.", section: "Capitolo 4" },
        { id: "pc2", text: "La mole è la quantità di sostanza che contiene un numero di Avogadro di particelle.", section: "Capitolo 2" },
      ],
    });
    seedPlan(db, {
      id: "chimica",
      subjectId: "chim",
      title: "Chimica, appello di febbraio",
      language: "it",
      target: 0.75,
      sourceIds: ["atkins"],
      topics: [
        { id: "legami", title: "Legami chimici" },
        { id: "mole", title: "La mole" },
      ],
    });
    db.exec(
      "INSERT INTO topic_passages(topic_id,passage_id) VALUES('legami','pc0'),('mole','pc2')",
    );
  } finally {
    db.close();
  }
}

/** Starts the flashcard job of a topic of `seedChimica` and returns its id. */
export async function makeCards(page: Page, topicId: "legami" | "mole"): Promise<string> {
  const { jobId } = (await page.evaluate(
    (topic) => window.pyxis.invoke("study.cardsGenerate", { planId: "chimica", topicId: topic }),
    topicId,
  )) as { jobId: string | null };
  if (!jobId) throw new Error(`no flashcard job started for ${topicId}`);
  return jobId;
}

/** The jobs Attività lists: the running and stopped ones, then the ones that finished today. */
export async function jobsNow(page: Page) {
  return page.evaluate(async () => {
    const [open, done] = (await Promise.all([
      window.pyxis.invoke("jobs.list", {}),
      window.pyxis.invoke("jobs.finished", {}),
    ])) as Array<Array<{ id: string; state: string; error: string | null; waitingUntil?: number; fallback?: { from: string; to: string; reason: string } }>>;
    return [...open!, ...done!];
  });
}
