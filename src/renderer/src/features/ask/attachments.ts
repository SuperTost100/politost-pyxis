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

function filesKey(chatId?: string): string {
  return chatId ? `pyxis-files:${chatId}` : "pyxis-files";
}

export function readPendingFiles(store: Pick<Storage, "getItem">, chatId?: string): string[] {
  try {
    const value = JSON.parse(store.getItem(filesKey(chatId)) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function writePendingFiles(
  store: Pick<Storage, "setItem" | "removeItem">,
  chatId: string | undefined,
  files: string[],
): void {
  if (files.length === 0) store.removeItem(filesKey(chatId));
  else store.setItem(filesKey(chatId), JSON.stringify(files));
}

/**
 * The chat Ask last showed, from the path the shell remembers for the Ask door. The whiteboard and the graph hand their
 * image back to that chat, so the student returns to the draft and files they left there.
 */
export function lastAskChat(store: Pick<Storage, "getItem">): string | undefined {
  try {
    const path = (JSON.parse(store.getItem("pyxis.lastDoorPath") ?? "{}") as { ask?: unknown }).ask;
    const match = typeof path === "string" ? path.match(/^\/ask\/([^/?#]+)$/) : null;
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Adds picked files to the pending list once each. Pending files survive leaving the chat, so picking a file that is
 * already waiting would otherwise attach it twice.
 */
export function addPendingFiles(current: string[], chosen: string[]): string[] {
  const next = [...current];
  for (const file of chosen) if (!next.includes(file)) next.push(file);
  return next;
}
