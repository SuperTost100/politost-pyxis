import { useSyncExternalStore } from "react";
import { invoke } from "../../lib/ipc";
import { createAttachQueue, createDraftFiles } from "./draftFiles";

/** The composer drafts of this window's session, and the queue that attaches files to them. */
export const drafts = createDraftFiles(sessionStorage);
export const attachQueue = createAttachQueue(drafts, (path, draft) =>
  invoke("chats.attach", draft ? { path, draft } : { path }),
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
