import type { AttachmentError, AttachmentView } from "../../../../shared/ipc";
import { DOCUMENT_EXTENSIONS, IMAGE_EXTENSIONS, MAX_ATTACHED_FILES } from "../../../../shared/source-types";
import { lastChat, parseTrail, TRAIL_STORE } from "../../app/trail";
import type { NewChatSubject } from "./scope";

/** Windows paths use `\`, so a `/` split alone shows the whole path. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

const PNG_PREFIX = "data:image/png;base64,";

/**
 * The whiteboard hands Ask one staged file and, with it, the image it staged.
 * Both leave sessionStorage here, so a preview never outlives its attachment or shows for a board that was only saved.
 */
export function takeBoardAttachment(
  store: Pick<Storage, "getItem" | "removeItem">,
): { path: string; preview?: string } | null {
  const path = store.getItem("pyxis-board-file");
  const png = store.getItem("pyxis-board-png");
  store.removeItem("pyxis-board-file");
  store.removeItem("pyxis-board-png");
  if (!path) return null;
  return png?.startsWith(PNG_PREFIX) ? { path, preview: png } : { path };
}

/**
 * The composer's draft and picked files belong to one chat, so each chat keeps its own for the session. A new chat
 * uses the plain key. Only paths are stored, never file contents.
 */
export function draftKey(chatId?: string): string {
  return chatId ? `pyxis-draft:${chatId}` : "pyxis-draft";
}

/**
 * A question that could not go out stays as its chat's draft, so the student finds it there and can send it again. A
 * typed question is that draft already; a suggestion chip's text becomes the draft only when the chat has none.
 */
export function keepUnsentQuestion(
  store: Pick<Storage, "getItem" | "setItem">,
  chatId: string | undefined,
  text: string,
): void {
  if (!store.getItem(draftKey(chatId))) store.setItem(draftKey(chatId), text);
}

function filesKey(chatId?: string): string {
  return chatId ? `pyxis-files:${chatId}` : "pyxis-files";
}

/**
 * A file waiting in the composer: core's id for it (`chats.attach`) and the name its chip shows until core says more.
 * `path` is where the student picked it from, so picking the same file again adds nothing.
 */
export type PickedFile = { id: string; name: string; path?: string };

/** The id of a chip that never reached core, because attaching the file was refused outright. */
export const LOCAL_PREFIX = "local-";
export const isLocalFile = (file: PickedFile): boolean => file.id.startsWith(LOCAL_PREFIX);

export function readPendingFiles(store: Pick<Storage, "getItem">, chatId?: string): PickedFile[] {
  try {
    const value = JSON.parse(store.getItem(filesKey(chatId)) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is PickedFile =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as PickedFile).id === "string" &&
        typeof (item as PickedFile).name === "string" &&
        ((item as PickedFile).path === undefined || typeof (item as PickedFile).path === "string"),
    );
  } catch {
    return [];
  }
}

/** Only files core holds are kept: a chip refused before core knew it has nothing to come back to. */
export function writePendingFiles(
  store: Pick<Storage, "setItem" | "removeItem">,
  chatId: string | undefined,
  files: PickedFile[],
): void {
  const kept = files.filter((file) => !isLocalFile(file));
  if (kept.length === 0) store.removeItem(filesKey(chatId));
  else store.setItem(filesKey(chatId), JSON.stringify(kept));
}

const SUBJECT_KEY = "pyxis-subject";

/**
 * The subject a student chose on a new chat's first page stays with that chat's draft until the first question is sent,
 * so a visit to the whiteboard, the graph or the Library does not lose it. Letting Pyxis pick is no choice and keeps nothing.
 */
export function readPendingSubject(store: Pick<Storage, "getItem">): NewChatSubject {
  try {
    const value = JSON.parse(store.getItem(SUBJECT_KEY) ?? "null") as { kind?: unknown; name?: unknown; id?: unknown } | null;
    if (value?.kind === "library") return { kind: "library" };
    if (value?.kind === "subject" && typeof value.name === "string")
      return { kind: "subject", name: value.name, ...(typeof value.id === "string" ? { id: value.id } : {}) };
  } catch {
    return { kind: "auto" };
  }
  return { kind: "auto" };
}

export function writePendingSubject(store: Pick<Storage, "setItem" | "removeItem">, choice: NewChatSubject): void {
  if (choice.kind === "auto") store.removeItem(SUBJECT_KEY);
  else store.setItem(SUBJECT_KEY, JSON.stringify(choice));
}

/**
 * The chat the page was opened from, read from the window's trail. The whiteboard and the graph hand their image back to
 * that chat, so the student returns to the draft and files they left there.
 */
export function lastAskChat(store: Pick<Storage, "getItem">): string | undefined {
  try {
    return lastChat(parseTrail(store.getItem(TRAIL_STORE)));
  } catch {
    return undefined;
  }
}

/** What a chat message can carry, without the dot. The picker uses it, and a drop leaves out anything else. */
export const ATTACH_EXTENSIONS = [...IMAGE_EXTENSIONS, ...DOCUMENT_EXTENSIONS] as const;

/** Splits granted paths into the ones a message can carry and a count of the rest (a smartbook, for example). */
export function attachable(paths: string[]): { paths: string[]; skipped: number } {
  const allowed = new Set<string>(ATTACH_EXTENSIONS);
  const kept = paths.filter((path) => allowed.has(fileName(path).split(".").pop()?.toLowerCase() ?? ""));
  return { paths: kept, skipped: paths.length - kept.length };
}

/** The reason an `attach` request that failed gives, from its error code. */
export function attachFailure(err: unknown): AttachmentError {
  const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
  if (code === "source-too-big") return "too-large";
  if (code === "file-access-denied") return "denied";
  return "unreadable";
}

/** The chip of a file that was refused before core held it, so its reason shows like any other. */
export function refusedFile(id: string, path: string, error: AttachmentError): AttachmentView {
  const name = fileName(path);
  const photo = IMAGE_EXTENSIONS.includes(name.split(".").pop()?.toLowerCase() as never);
  return { id, name, kind: photo ? "photo" : "document", size: 0, state: "failed", error };
}

/** The line a chip shows under a file's name: what the reading is doing, or why it failed. Null when the file is ready. */
export function attachmentLine(view: AttachmentView): { key: string; values?: Record<string, unknown> } | null {
  if (view.state === "failed") {
    const error = view.error ?? "unreadable";
    return {
      key: error === "too-large" ? `ask.attach.error.tooLarge${view.kind === "photo" ? "Photo" : "Document"}` : `ask.attach.error.${error === "too-many" ? "tooMany" : error}`,
      values: { max: MAX_ATTACHED_FILES },
    };
  }
  if (view.state === "needs-data") return { key: "ask.attach.needsData" };
  if (view.state === "ready") return null;
  if (view.phase === "scan")
    return view.pages ? { key: "ask.attach.scanPage", values: { page: view.page, pages: view.pages } } : { key: "ask.attach.scan" };
  const percent = Math.round((view.progress ?? 0) * 100);
  return percent > 0 ? { key: "ask.attach.readingPercent", values: { percent } } : { key: "ask.attach.reading" };
}
