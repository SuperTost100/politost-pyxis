import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { endConversation, type TurnInput } from "../engine/funnel";
import type { Runner } from "../jobs/runner";
import { ocrConsent, ocrDataStatus } from "../sources/ocr-data";
import { startScan } from "../sources/ocr-job";
import { IpcError, type AttachmentView } from "../../shared/ipc";
import { createHeldFiles, setHeldFiles } from "./held-files";
import { isFigureFixCall, recordedPlanRun } from "../engine/recorded-plan";
import { exportChat, type ChatExportLanguage } from "./export";
import { searchChats } from "./search";
import { chatUsage } from "../engine/usage";
import { removeBlobLeftovers } from "../share/usage";
import { sessionsOpened } from "./sessions";
import { chatToolList } from "../tools/registry";
import { restoreToolResult, retryToolResult, startToolResults, toolView, undoToolResult } from "../tools/results";
import { setToolRunner } from "../tools/jobs";
import { revokeChatTools, setTools } from "../tools/server";
import type { ToolResultView } from "../../shared/ipc";
import type { FigureEvent } from "../math/figures";
import { askTurn, chatContext, chatPickedSources, chatPlan, chatSubject, chatSubjectBy, chatTitle, clearChatContext, deleteChat, heldSources, listChats, rateMessage, removeEmptyChat, removeEmptyChats, readChat, regenerateTurn, renameChat, seedChat, setChatSubject } from "./turn";

/**
 * Recorded reply for tests. With a delay it waits, then streams the words, so the thinking and streaming states can be
 * seen. A line `@@tool <name> <json arguments>` calls that Pyxis tool through the turn's own server, as a CLI would, with
 * the text before it streamed first and the text after it streamed once the tool answered. An `_hold` path in the
 * arguments keeps the call at work until the test creates that file.
 */
function recordedReply(text: string, delayMs: number) {
  return async (input: { signal?: AbortSignal; onDelta?: (text: string) => void; tools?: TurnInput["tools"] }) => {
    const pause = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        input.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const parts = text.split(/^@@tool (\S+) (.*)$\n?/m);
    let shown = "";
    let calls = 0;
    for (let at = 0; at < parts.length; at += 3) {
      const piece = parts[at] ?? "";
      if (delayMs > 0) {
        await pause(delayMs / 2);
        const words = piece.split(/(?<=\s)/);
        const step = Math.max(1, Math.ceil(words.length / 20));
        for (let end = step; end < words.length + step; end += step) {
          input.onDelta?.(shown + words.slice(0, end).join(""));
          await pause(delayMs / 2 / Math.ceil(words.length / step));
        }
      }
      shown += piece;
      const tool = parts[at + 1];
      if (!tool || !input.tools) continue;
      const { _hold: hold, ...args } = JSON.parse(parts[at + 2] ?? "{}") as { _hold?: string } & Record<string, unknown>;
      const id = `recorded-${(calls += 1)}`;
      // The text before the call has streamed when the call starts, as it has on a CLI.
      input.onDelta?.(shown);
      input.tools.onTool?.({ phase: "start", id, tool });
      while (hold && !existsSync(hold)) await pause(50);
      const response = await fetch(input.tools.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${input.tools.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: calls, method: "tools/call", params: { name: tool, arguments: args } }),
        signal: input.signal,
      });
      const reply = (await response.json()) as { result?: { isError?: boolean } };
      input.tools.onTool?.({ phase: "end", id, tool, ...(reply.result?.isError ? { failed: true } : {}) });
    }
    if (calls > 0) input.onDelta?.(shown);
    // Rough counts, so the token figures have something to show in end-to-end runs.
    return {
      text: shown,
      model: "fixture",
      provider: "fixture",
      inputTokens: 1200,
      outputTokens: Math.ceil(shown.length / 4),
      cacheReadTokens: 800,
    };
  };
}

/**
 * The recorded run of a chat turn: the recorded reply for the tutor, and the recorded `figureFix` replies of the plan
 * fixture, when there is one, for the call that corrects a figure.
 */
function recordedChat(text: string, delayMs: number, figureFixes?: string) {
  const reply = recordedReply(text, delayMs);
  const fixes = figureFixes ? recordedPlanRun(figureFixes) : undefined;
  return ((input: Parameters<typeof reply>[0] & { system?: string }) =>
    fixes && isFigureFixCall(input.system) ? fixes(input as never) : reply(input)) as unknown as typeof reply;
}

export function chatHandlers(
  db: Database.Database,
  workspace = "",
  fixtureReply?: string,
  replyDelayMs = 0,
  figureFixes?: string,
  /** What attaching a file needs: the job runner and a way to tell the window. Without them no file can be attached. */
  files?: { runner: Runner; emit: (view: AttachmentView) => void },
) {
  const tess = join(workspace, "runtimes", "tesseract");
  const held = files
    ? createHeldFiles({
        db,
        workspace,
        runner: files.runner,
        emit: files.emit,
        // A scan starts by itself when the student agreed to local OCR and its data is here, as the Library's does.
        scan: async (sourceId) => {
          if (!ocrConsent(db) || (await ocrDataStatus(tess)).state !== "ready") return "needs-data";
          startScan(db, files.runner, sourceId);
          return "started";
        },
      })
    : null;
  setHeldFiles(held);
  // The tools the model answering a chat may call (src/core/tools). A map or a quiz a restart cut off goes on.
  setToolRunner(files?.runner);
  setTools(chatToolList(db, files !== undefined));
  startToolResults(db);
  // Files attached before the last quit and never sent have nothing left to send them.
  held?.sweep();
  // A chat opened and never sent has nothing to come back to either.
  removeEmptyChats(db, workspace);
  // And the files a removal could not delete (the system held them) stay under a temporary name until now.
  if (workspace) removeBlobLeftovers(workspace);
  const needHeld = () => {
    if (!held) throw new Error("attachments-unavailable");
    return held;
  };
  return {
    async attach(input: { path: string; draft?: string }) {
      // A draft is a chat's composer or a new chat's (empty). A pick still registering when its chat was deleted is refused,
      // so no hidden copy is made for a chat that is gone.
      const gone = () => Boolean(input.draft) && !db.prepare(`SELECT 1 FROM chats WHERE id = ?`).get(input.draft);
      if (gone()) throw new IpcError("chat-missing", "errors.internal");
      const view = await needHeld().attach(input.path, input.draft ?? "");
      // The chat was removed while the file was being registered (an empty chat the student left): the file belongs to
      // nobody, so what it made goes and the pick is refused.
      if (gone()) {
        needHeld().detach(view.id);
        throw new IpcError("chat-missing", "errors.internal");
      }
      return view;
    },
    detach(input: { id: string }) {
      needHeld().detach(input.id);
      return { ok: true as const };
    },
    attachments(input: { ids: string[] }) {
      return needHeld().list(input.ids);
    },
    /** The student agreed to download the OCR data and it is here: the scan starts. */
    async attachScan(input: { id: string }) {
      const { state } = await ocrDataStatus(tess);
      if (state !== "ready") throw new Error(`ocr-data-${state}`);
      return needHeld().scan(input.id);
    },
    list() {
      return listChats(db).map((row) => ({
        id: row.id,
        title: row.title,
        subject: row.subject,
        updatedAt: row.updated_at,
      }));
    },
    read(input: { chatId: string }) {
      return {
        title: chatTitle(db, input.chatId),
        sourceIds: chatPickedSources(db, input.chatId),
        planId: chatPlan(db, input.chatId),
        subject: chatSubject(db, input.chatId),
        subjectBy: chatSubjectBy(db, input.chatId),
        context: chatContext(db, input.chatId),
        held: heldSources(db, input.chatId),
        usage: chatUsage(db, input.chatId),
        sessions: sessionsOpened(db, input.chatId),
        messages: readChat(db, input.chatId),
      };
    },
    seed(input: {
      planId?: string;
      kind: "answer" | "passage";
      title: string;
      body: string;
      sourceIds?: string[];
      subject?: string;
    }) {
      return seedChat(db, input);
    },
    setSubject(input: { chatId: string; subject: string | null }) {
      setChatSubject(db, input.chatId, input.subject);
      return { ok: true as const };
    },
    clearContext(input: { chatId: string }) {
      // The next message's context block says there is none, so the tool's session goes on.
      clearChatContext(db, input.chatId);
      return { ok: true as const };
    },
    /** The student left the chat: its engine conversation, and a live CLI process with it, can stop. */
    leave(input: { chatId: string; draft?: boolean }) {
      endConversation(input.chatId);
      // A chat opened with "Chiedi" and left unsent is not kept, unless its composer holds text or a file.
      removeEmptyChat(db, workspace, input.chatId, { draft: input.draft });
      return { ok: true as const };
    },
    undoTool(input: { chatId: string; resultId: string }) {
      return undoToolResult(db, input.chatId, input.resultId);
    },
    restoreTool(input: { chatId: string; resultId: string }) {
      return restoreToolResult(db, input.chatId, input.resultId);
    },
    toolView(input: { chatId: string; resultId: string }) {
      return toolView(db, input.chatId, input.resultId);
    },
    retryTool(input: { chatId: string; resultId: string }) {
      return retryToolResult(db, input.chatId, input.resultId);
    },
    rate(input: { messageId: string; reaction: "up" | "down" }) {
      return { reaction: rateMessage(db, input.messageId, input.reaction) };
    },
    rename(input: { chatId: string; title: string }) {
      renameChat(db, input.chatId, input.title);
      return { ok: true as const };
    },
    remove(input: { chatId: string }) {
      endConversation(input.chatId);
      revokeChatTools(input.chatId);
      // The files its composer still held go first: what a stored question names stays with the chat until it is deleted.
      held?.discardDraft(input.chatId);
      deleteChat(db, workspace, input.chatId);
      return { ok: true as const };
    },
    search(input: { query: string; subject?: string }) {
      return searchChats(db, input.query, input.subject);
    },
    exportChat(input: { chatId: string; language: ChatExportLanguage }) {
      return exportChat(db, input.chatId, input.language);
    },
    regenerate(input: {
      chatId: string;
      engine?: "chat" | "strong";
      resume?: boolean;
      allowGeneral?: boolean;
      signal?: AbortSignal;
      onDelta?: (text: string) => void;
      onFigure?: (event: FigureEvent) => void;
      onPassages?: (passages: Array<{ index: number; label: string }>) => void;
      onTool?: (view: ToolResultView) => void;
    }) {
      return regenerateTurn(db, {
        ...input,
        held,
        workspace,
        run: fixtureReply ? recordedChat(fixtureReply, replyDelayMs, figureFixes) : undefined,
      });
    },
    ask(input: {
      chatId?: string;
      text: string;
      sourceIds?: string[];
      planId?: string | null;
      allowGeneral?: boolean;
      signal?: AbortSignal;
      onDelta?: (text: string) => void;
      onFigure?: (event: FigureEvent) => void;
      onPassages?: (passages: Array<{ index: number; label: string }>) => void;
      onQuestion?: (messageId: string, chatId: string) => void;
      onTool?: (view: ToolResultView) => void;
      subject?: string | null;
      attachments?: string[];
    }) {
      return askTurn(db, {
        ...input,
        held,
        workspace,
        run: fixtureReply ? recordedChat(fixtureReply, replyDelayMs, figureFixes) : undefined,
      });
    },
  };
}
