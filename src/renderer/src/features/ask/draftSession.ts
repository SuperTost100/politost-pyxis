import { useSyncExternalStore } from "react";
import { invoke } from "../../lib/ipc";
import { createAttachQueue, createDraftFiles, syncFiles } from "./draftFiles";

/** The composer drafts of this window's session, and the queue that attaches files to them. */
export const drafts = createDraftFiles(sessionStorage);
export const attachQueue = createAttachQueue(drafts, (path, draft) =>
  invoke("chats.attach", draft ? { path, draft } : { path }),
  (id) => void invoke("chats.detach", { id }).catch(() => undefined),
);

/** The files of one draft ("" for a new chat's), following every change to it. */
export function useDraftFiles(draft: string) {
  return useSyncExternalStore(drafts.files.subscribe, () => drafts.files.get(draft));
}
export function useFileViews() {
  return useSyncExternalStore(drafts.views.subscribe, drafts.views.get);
}
export function useFilePreviews() {
  return useSyncExternalStore(drafts.previews.subscribe, drafts.previews.get);
}

/** Asks core which of a draft's files it still holds, and drops the rest (see `syncFiles`). */
export const syncDraftFiles = syncFiles(drafts, (ids) => invoke("chats.attachments", { ids }));
