import type Database from "better-sqlite3";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import { IpcError, isAbort } from "../../shared/ipc";
import { dataBlock } from "../chat/prompts";
import { isProviderCurrent } from "../engine/funnel";
import { generate } from "../engine/generate";
import { systemPrompt } from "../engine/prompts";
import { solverSelection } from "../engine/selection";
import type { Tool, ToolTurn } from "./server";

/**
 * `ask_stronger_model`: the chat runs on a quick model, and an exercise beyond what it solves reliably goes to the
 * strong model of the same tool as one sub-call (`solverSelection`), whose checked solution comes back as the tool's
 * result. The chat's model then writes the answer as it always does; the solver's text is material for it. The call
 * shows a working line in the answer, and the tag under the answer names both models (`chat_tool_results` keeps which).
 *
 * What it sends: only what the chat's model passes in the arguments, which it took from this chat's conversation, its
 * passages and its attached files, the same content every chat turn already sends to the same tool. A pinned model of
 * another tool is the student's own choice in Settings, and `runTurn` refuses a tool whose notice the student has not
 * confirmed, as it does for the chat. The student's results are the one thing a chat sends only to a tool cleared for
 * them (`read_progress`): a turn that read them hands nothing on unless the solver's tool is cleared too
 * (`isProviderCurrent`), which the chat's own tool always is when it read them. No other chat, no file outside this chat
 * and no stored data is read here.
 *
 * The sub-call is a one-shot run: no conversation, so it never touches the chat's stored session, the "in step" record
 * or the tool server's token, and a tool that can skip saving it in its history does (`persist: false` in `runTurn`). It
 * gets no tools. It counts in the chat's usage under the model that ran it, and a usage limit or a refused model is
 * recorded as any call records it (`generate`), with no move to another tool: the chat's model is told and answers alone.
 */

export const SOLVER_TOOL = "ask_stronger_model";

/**
 * How long the sub-call may take. Antigravity ends any tool call at 180 seconds and cannot be told otherwise (live check,
 * agy 1.5.17: "timed out after 3m0s"); Claude Code and Codex are given `TOOL_CALL_LIMIT_SEC`. The sub-call stops itself
 * earlier, so the chat's model always gets a result it can act on, and the student never waits more than this.
 */
export const SOLVER_DEADLINE_MS = 150_000;
let deadlineMs = SOLVER_DEADLINE_MS;

/** End-to-end runs and tests shorten the deadline to see the time-out. */
export function setSolverDeadline(ms: number | undefined): void {
  deadlineMs = ms ?? SOLVER_DEADLINE_MS;
}

/** Characters each argument may hold: a long statement with its data, and the passages the solution needs. */
const EXERCISE_MAX = 8000;
const ASKED_MAX = 2000;
const MATERIAL_MAX = 16000;

export const solverInput = z
  .object({
    exercise: z.string().trim().min(20).max(EXERCISE_MAX),
    request: z.string().trim().min(1).max(ASKED_MAX),
    material: z.string().trim().max(MATERIAL_MAX).optional(),
  })
  .strict();

export const SOLVER_DESCRIPTION = [
  "Hands one exercise to a stronger model, which solves it step by step and checks its result. It is slower: it takes from twenty seconds to two minutes, and it can be called once per answer.",
  "Call it once, before you write your solution, when the student asks you to solve or check an exercise that needs a proof or a long computation of several steps: a differential equation with initial conditions, a multiple integral with a change of variables, a limit or a series that needs several theorems, a problem that combines several laws. Call it even when you think you could solve it yourself: its solution is checked and more reliable than yours. Never call it for an explanation, a definition, a short or routine exercise of a few steps, or a question about the student's material.",
  "The stronger model sees nothing but these arguments: not the conversation, not the passages, not the attached files. Send a self-contained task. `exercise`: the complete statement with every datum, formula and condition, copied in full. `request`: what the student asked and, when they are working on it themselves, what they already did. `material`: the definitions, notation and passages from the conversation that the solution needs, copied in full, or nothing.",
  "Its result is material for your answer, not the answer: read it, then answer the student as you always do (hints first when they are working on it themselves, the full solution when they asked for it), in their language. Do not say that another model solved it.",
].join(" ");

/** What the chat's model does when the stronger model gives nothing: the student hears it plainly, once, at the end. */
const ALONE =
  "Solve the exercise yourself and answer as usual. At the end, add one sentence telling the student to check this result with care, because you could not verify it as thoroughly as usual. Do not mention another model or a tool.";
const TIME_OUT = (seconds: number) =>
  `The stronger model did not answer within ${seconds} seconds. Do not call it again. ${ALONE}`;
const LIMIT = `The stronger model is not available now: its usage limit on the student's subscription is reached. Do not call it again. ${ALONE}`;
const NOT_INCLUDED = `The stronger model is not included in the student's subscription. Do not call it again. ${ALONE}`;
const FAILED = `The stronger model did not give a usable answer. Do not call it again. ${ALONE}`;

/** What a stored sub-call keeps: the model that solved it and how long it took. */
export type SolverData = { provider: string; model: string; ms: number };

export function storeSolved(db: Database.Database, chatId: string, data: SolverData, now = Date.now()): string {
  const id = uuidv7(now);
  db.prepare(
    `INSERT INTO chat_tool_results (id, chat_id, message_id, tool, data_json, created_at)
     VALUES (?, ?, NULL, ?, ?, ?)`,
  ).run(id, chatId, SOLVER_TOOL, JSON.stringify(data), now);
  return id;
}

/** Whether a model call is the stronger model's sub-call, by its system prompt (the recorded engine of tests asks). */
export function isSolverCall(system: string | undefined): boolean {
  return system === systemPrompt("chat.solve");
}

/** The message the sub-call sends: the language and the three arguments, each as data. */
export function solverPrompt(language: string, args: z.infer<typeof solverInput>): string {
  return [
    `Language: ${language}.`,
    `The exercise:\n${dataBlock("exercise", args.exercise)}`,
    `What the student asked:\n${dataBlock("request", args.request)}`,
    args.material ? `Material from the conversation:\n${dataBlock("material", args.material)}` : "No other material.",
  ].join("\n\n");
}

export function solverTool(db: Database.Database): Tool {
  return {
    name: SOLVER_TOOL,
    description: SOLVER_DESCRIPTION,
    input: solverInput,
    // Offered only where it can run: a turn that can make a model call of its own, and a stronger model to give it to.
    offered: (turn) => turn.call !== undefined && solverSelection(db, turn.engine()) !== null,
    async run(turn: ToolTurn, raw) {
      const args = raw as z.infer<typeof solverInput>;
      if (turn.tally[SOLVER_TOOL]) return { text: "You already asked the stronger model in this answer. Finish the answer yourself.", isError: true };
      const call = turn.call?.();
      const selection = solverSelection(db, turn.engine());
      if (!call || !selection) return { text: FAILED };
      if ((turn.tally.results ?? 0) > 0 && !isProviderCurrent(selection.provider))
        return {
          text: `The stronger model may not receive the student's results, which this answer read. Do not call it again. ${ALONE}`,
        };
      turn.tally[SOLVER_TOOL] = 1;
      const started = Date.now();
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), deadlineMs);
      const signal = call.signal ? AbortSignal.any([call.signal, deadline.signal]) : deadline.signal;
      try {
        const result = await generate({
          prompt: solverPrompt(call.language, args),
          system: systemPrompt("chat.solve"),
          // No `chosenFor`: the call never moves to another tool, whatever happens to this one.
          selection,
          signal,
          ...(call.run ? { run: call.run } : {}),
          usage: call.usage,
        });
        if (!result.text.trim() || result.finishReason === "length" || result.finishReason === "error") return { text: FAILED };
        const id = storeSolved(db, turn.chatId, { provider: result.provider, model: result.model || selection.model, ms: Date.now() - started });
        return {
          text: `The stronger model's solution (write your answer from it, as your instructions say):\n\n${result.text.trim()}`,
          shown: { resultId: id },
        };
      } catch (err) {
        if (deadline.signal.aborted && !call.signal?.aborted) return { text: TIME_OUT(Math.round(deadlineMs / 1000)) };
        if (call.signal?.aborted || isAbort(err)) throw err;
        const code = err instanceof IpcError ? err.code : "";
        if (code === "quota") return { text: LIMIT };
        if (code === "model-not-included") return { text: NOT_INCLUDED };
        return { text: FAILED };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
