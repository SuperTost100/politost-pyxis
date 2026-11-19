import type { AttachmentView } from "../../../../shared/ipc";
import { MAX_ATTACHED_FILES } from "../../../../shared/source-types";
import {
  attachFailure,
  fileName,
  isLocalFile,
  LOCAL_PREFIX,
  readPendingFiles,
  refusedFile,
  writePendingFiles,
  type PickedFile,
} from "./attachments";

/** An image staged for the next message, shown in its attachment chip. A pasted one is named for what it is. */
export type Preview = { src: string; alt: string; name?: string };

type Listener = () => void;

/** A small observable value for `useSyncExternalStore`: `get` returns the same object until `set` changes it. */
function observable<T>(initial: T) {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The files of each composer draft (a chat's, or "" for a new chat's), what core says of each file and the previews of the
 * images staged for them. They live outside the page, so an attach that finishes while another chat is on screen, or while
 * Chiedi is not mounted, still lands in the draft that started it. A draft's files are kept in the session by core's ids.
 */
export function createDraftFiles(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) {
  const drafts = new Map<string, PickedFile[]>();
  const listeners = new Set<Listener>();
  const files = {
    get(draft: string): PickedFile[] {
      let list = drafts.get(draft);
      if (!list) {
        list = readPendingFiles(storage, draft || undefined);
        drafts.set(draft, list);
      }
      return list;
    },
    set(draft: string, next: PickedFile[] | ((current: PickedFile[]) => PickedFile[])) {
      const value = typeof next === "function" ? next(files.get(draft)) : next;
      drafts.set(draft, value);
      writePendingFiles(storage, draft || undefined, value);
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const views = observable<Record<string, AttachmentView>>({});
  const previews = observable<Record<string, Preview>>({});
  return {
    files,
    views: {
      ...views,
      put(...list: AttachmentView[]) {
        views.set({ ...views.get(), ...Object.fromEntries(list.map((view) => [view.id, view])) });
      },
    },
    previews: {
      ...previews,
      put(id: string, preview: Preview) {
        previews.set({ ...previews.get(), [id]: preview });
      },
      drop(ids: string[]) {
        previews.set(Object.fromEntries(Object.entries(previews.get()).filter(([id]) => !ids.includes(id))));
      },
    },
  };
}

export type DraftFiles = ReturnType<typeof createDraftFiles>;

/**
 * Attaches files to a draft. Each draft has its own queue: its batches run one after the other, so the count against the
 * most a message carries is always the draft's own, and a file picked past it is marked as over the limit when it is
 * picked. The result of each file is applied to the draft that asked for it, whatever is on screen. A send waits for the
 * draft's queue (`idle`) before it reads the draft's files.
 */
export function createAttachQueue(
  drafts: DraftFiles,
  /** Asks core to attach one file to a draft; rejects with the request's error when core refuses it. */
  attachInCore: (path: string, draft: string) => Promise<AttachmentView>,
) {
  const tails = new Map<string, Promise<void>>();
  const refuse = (draft: string, path: string, error: Parameters<typeof refusedFile>[2]) => {
    const id = `${LOCAL_PREFIX}${crypto.randomUUID()}`;
    drafts.views.put(refusedFile(id, path, error));
    drafts.files.set(draft, (now) => [...now, { id, name: fileName(path), path }]);
  };
  async function run(draft: string, paths: string[], preview?: Preview) {
    for (const path of paths) {
      const now = drafts.files.get(draft);
      // Pending files survive leaving the chat, so picking a file that is already waiting must not attach it twice.
      if (now.some((file) => file.path === path)) continue;
      // Only files core holds count: a chip refused before core knew it is never sent.
      if (now.filter((file) => !isLocalFile(file)).length >= MAX_ATTACHED_FILES) {
        refuse(draft, path, "too-many");
        continue;
      }
      try {
        const view = await attachInCore(path, draft);
        drafts.views.put(view);
        drafts.files.set(draft, (list) => (list.some((file) => file.id === view.id) ? list : [...list, { id: view.id, name: view.name, path }]));
        if (preview) drafts.previews.put(view.id, preview);
      } catch (error) {
        refuse(draft, path, attachFailure(error));
      }
    }
  }
  return {
    /** Queues the files for the draft. Resolves when they have all been attached or refused. */
    attach(draft: string, paths: string[], preview?: Preview): Promise<void> {
      const tail = (tails.get(draft) ?? Promise.resolve()).then(() => run(draft, paths, preview));
      const next = tail.catch(() => undefined);
      tails.set(draft, next);
      void next.then(() => {
        if (tails.get(draft) === next) tails.delete(draft);
      });
      return tail;
    },
    /** Whether the draft still has files being attached. */
    busy: (draft: string): boolean => tails.has(draft),
    /** Resolves once everything queued for the draft so far has been applied. */
    idle: async (draft: string): Promise<void> => {
      while (tails.has(draft)) await tails.get(draft);
    },
  };
}
