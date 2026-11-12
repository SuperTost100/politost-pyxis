import type { RequestOutput } from "@shared/ipc";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, type MenuProps } from "antd";
import { ChevronDown, Folder, FolderPlus, FolderX } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { MenuButton, MenuItemArea } from "../../components/ItemMenu";
import { Logo } from "../../components/Logo";
import { Popover } from "../../components/Popover";
import { invoke } from "../../lib/ipc";
import { reportError } from "../../lib/errorReports";
import { refreshSubjects } from "../../lib/refreshSubjects";
import { closeUpShelves } from "./closeUpShelves";
import type { LibrarySource } from "./LibraryShelf";
import "./LinkedFolders.css";

type LinkedFolder = RequestOutput<"sources.linkedFolders">[number];

/** A folder's short name: its last two folders, "Polito › Fisica", as the student knows it. */
export const folderLabel = (path: string) => path.split(/[\\/]/).filter(Boolean).slice(-2).join(" › ");

const messageKeyOf = (err: unknown): string =>
  err && typeof err === "object" && "messageKey" in err
    ? String((err as { messageKey: unknown }).messageKey)
    : "sources.linked.errors.failed";

/** How long ago Pyxis last looked, in the window's language: "2 minuti fa", "ieri". */
function ago(at: number, now: number, language: string): string | null {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 60) return null;
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return format.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return format.format(-hours, "hour");
  return format.format(-Math.round(hours / 24), "day");
}

/** The file manager's own name on this system, for "Mostra nel Finder". */
const revealKey = (platform: string) =>
  platform === "darwin"
    ? "sources.folders.revealMac"
    : platform === "win32"
      ? "sources.folders.revealWindows"
      : "sources.folders.revealLinux";

/**
 * The Library's linked folders: one control in the head, "3 cartelle collegate", that opens a list growing from it. Each
 * folder shows its short path, how many files Pyxis reads there and when it last looked, or that it is being read, or
 * that it is no longer on disk with "Trova la cartella…". Its menu, on the dots and on a right-click, shows it in the
 * file manager, reads it again now, or unlinks it after a confirmation; the shelves then close up where its files were.
 * With no folder linked the control links one, through setup's material step, as "Collega un'altra cartella" does.
 */
export function LinkedFolders({
  sources,
  onLink,
}: {
  /** The Library's files, to count the ones the student added and to find the covers that leave. */
  sources: readonly LibrarySource[] | undefined;
  onLink: () => void;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const listId = useId();
  // What the last action did, for a screen reader, and an error next to the folder it is about.
  const [said, setSaid] = useState("");
  const [problem, setProblem] = useState<{ folderId: string; text: string; relink?: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [modal, modalContext] = Modal.useModal();
  const folders = useQuery({
    queryKey: ["linked-folders"],
    queryFn: () => invoke("sources.linkedFolders", {}),
    // A folder being read shows its count moving, in the list and on the control.
    refetchInterval: (query) => (query.state.data?.some((folder) => folder.state === "reading") ? 1500 : false),
  });
  // "2 minuti fa" moves on while the list is open.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [open]);

  const list = folders.data;
  if (!list) return <span className="px-folders-slot" aria-hidden />;
  if (!list.length)
    return (
      <Button variant="secondary" className="px-folders-control" onClick={onLink}>
        <FolderPlus size={16} strokeWidth={1.75} aria-hidden />
        {t("sources.shelf.linkFolder")}
      </Button>
    );

  const reading = list.some((folder) => folder.state === "reading");
  const missing = list.filter((folder) => folder.state === "missing").length;
  const added = sources?.filter((source) => !source.linked).length ?? 0;
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["linked-folders"] });
    void client.invalidateQueries({ queryKey: ["sources"] });
  };
  const focusControl = () => anchor.current?.querySelector("button")?.focus({ preventScroll: true });

  async function reread(folder: LinkedFolder) {
    setProblem(null);
    try {
      await invoke("sources.rereadFolder", { folderId: folder.id });
      setSaid(t("sources.folders.rereading", { name: folderLabel(folder.path) }));
    } catch (err) {
      setProblem({ folderId: folder.id, text: t(messageKeyOf(err)) });
    }
    void client.invalidateQueries({ queryKey: ["linked-folders"] });
  }

  async function reveal(folder: LinkedFolder) {
    setProblem(null);
    const shown = await window.pyxis.revealLinkedFolder(folder.id).catch(() => false);
    if (!shown) setProblem({ folderId: folder.id, text: t("sources.folders.revealFailed") });
  }

  /** Points a missing folder at the folder the student picks, when it holds the same files. */
  async function find(folder: LinkedFolder) {
    setProblem(null);
    let picked: string[] | null;
    try {
      picked = await window.pyxis.showOpenDialog({
        title: t("sources.folders.findTitle", { name: folderLabel(folder.path) }),
        properties: ["openDirectory"],
      });
    } catch (err) {
      setProblem({ folderId: folder.id, text: t(messageKeyOf(err)) });
      return;
    }
    const path = picked?.[0];
    if (!path) return;
    try {
      const found = await invoke("sources.relocateFolder", { folderId: folder.id, path });
      if (found.same) {
        setSaid(t("sources.folders.found", { name: folderLabel(folder.path), count: found.total }));
        refresh();
      } else
        setProblem({
          folderId: folder.id,
          text: t("sources.folders.notSame", { name: folderLabel(path), matched: found.matched, count: found.total }),
          relink: path,
        });
    } catch (err) {
      setProblem({ folderId: folder.id, text: t(messageKeyOf(err)) });
    }
  }

  /** Links the folder the student found as a new one, with the subjects Pyxis offers, as at the next start. */
  async function linkAsNew(folder: LinkedFolder, path: string) {
    setProblem(null);
    try {
      const linked = await invoke("sources.linkFolders", { paths: [path], mode: folder.mode });
      await invoke("sources.confirmFolders", {
        folders: linked.folders.map((item) => ({ folderId: item.id, subjects: [] })),
      });
      setSaid(t("sources.folders.linkedNew", { name: folderLabel(path) }));
      refresh();
      void refreshSubjects(client);
    } catch (err) {
      setProblem({ folderId: folder.id, text: t(messageKeyOf(err)) });
    }
  }

  function unlink(folder: LinkedFolder) {
    const name = folderLabel(folder.path);
    const own = sources?.filter((source) => source.linked?.folderId === folder.id) ?? [];
    // A copy the student imported before linking still has its stored file, and stays.
    const kept = own.filter((source) => source.blobSha).length;
    const leaving = own.length - kept;
    // The list gives way to the confirmation, which grows from where it was asked for.
    setOpen(false);
    // Where the focus goes once the confirmation has closed: the control, or the list again after a failure. The
    // dialog gives the focus back to where it was opened from once its exit ends, which is gone, so this runs after.
    let failed = false;
    void modal.confirm({
      title: t("sources.folders.unlinkTitle", { name }),
      icon: null,
      width: 520,
      content: (
        <div className="px-folders-confirm">
          <p>{t("sources.folders.unlinkLead", { count: leaving })}</p>
          <ul>
            {kept ? <li>{t("sources.folders.unlinkKept", { count: kept })}</li> : null}
            <li>{t("sources.folders.unlinkMade")}</li>
            <li>{t("sources.folders.unlinkCited")}</li>
          </ul>
        </div>
      ),
      okText: t("sources.folders.unlinkConfirm"),
      okButtonProps: { danger: true },
      cancelText: t("sources.sort.cancel"),
      autoFocusButton: "cancel",
      afterClose: () => {
        if (failed) setOpen(true);
        else focusControl();
      },
      onOk: async () => {
        setProblem(null);
        try {
          await closeUpShelves(
            own.filter((source) => !source.blobSha).map((source) => source.id),
            async () => {
              const result = await invoke("sources.unlinkFolder", { folderId: folder.id });
              setSaid(t("sources.folders.unlinked", { name, count: result.removed }));
              await Promise.all([
                client.refetchQueries({ queryKey: ["sources"] }),
                client.refetchQueries({ queryKey: ["linked-folders"] }),
              ]);
            },
          );
          void refreshSubjects(client);
          void client.invalidateQueries({ queryKey: ["jobs"] });
        } catch (err) {
          // Nothing was done: the list opens again on the folder, with the error under it.
          reportError(err);
          setProblem({ folderId: folder.id, text: t("sources.folders.unlinkFailed", { name }) });
          failed = true;
        }
      },
    });
  }

  const menuOf = (folder: LinkedFolder): MenuProps => ({
    items: [
      { key: "reveal", label: t(revealKey(window.pyxis.platform)), disabled: folder.state === "missing" },
      { key: "reread", label: t("sources.folders.reread") },
      { type: "divider" },
      { key: "unlink", label: t("sources.folders.unlink"), danger: true },
    ],
    onClick: ({ key }) => {
      if (key === "reveal") void reveal(folder);
      if (key === "reread") void reread(folder);
      if (key === "unlink") unlink(folder);
    },
  });

  const line = (folder: LinkedFolder) => {
    if (folder.state === "missing") return t("sources.folders.missing");
    if (folder.state === "reading")
      return folder.files
        ? t("sources.folders.readingCount", { read: folder.read, count: folder.files })
        : t("sources.folders.readingStart");
    const files = folder.files ? t("sources.folders.files", { count: folder.files }) : t("sources.folders.noFiles");
    if (folder.checkedAt === null) return files;
    const when = ago(folder.checkedAt, now, i18n.language);
    return `${files} · ${when ? t("sources.folders.checked", { when }) : t("sources.folders.checkedNow")}`;
  };

  return (
    <>
      {modalContext}
      <p className="visually-hidden" role="status">
        {said}
      </p>
      <span ref={anchor} className="px-folders-anchor">
        <Button
          variant="secondary"
          className="px-folders-control"
          // The name a screen reader hears says what the red dot and the turning mark show.
          aria-label={[
            t("sources.folders.control", { count: list.length }),
            missing ? t("sources.folders.controlMissing", { count: missing }) : "",
            reading ? t("sources.folders.controlReading") : "",
          ].join("")}
          expanded={open}
          hasPopup="dialog"
          controls={open ? listId : undefined}
          onClick={() => setOpen((was) => !was)}
        >
          {reading ? <Logo working decorative size={16} /> : <Folder size={16} strokeWidth={1.75} aria-hidden />}
          <span>{t("sources.folders.control", { count: list.length })}</span>
          {missing ? <span className="px-folders-warn" aria-hidden /> : null}
          <ChevronDown size={14} strokeWidth={1.75} className="px-folders-chevron" aria-hidden />
        </Button>
      </span>
      <Popover
        open={open}
        anchor={anchor}
        id={listId}
        label={t("sources.folders.title")}
        className="px-folders-pop"
        onClose={() => setOpen(false)}
      >
        <h2 className="px-folders-title">{t("sources.folders.title")}</h2>
        <ul className="px-folders-list">
          {list.map((folder) => {
            const name = folderLabel(folder.path);
            const note = problem?.folderId === folder.id ? problem : null;
            return (
              <MenuItemArea
                key={folder.id}
                className={`px-folders-row${folder.state === "missing" ? " is-missing" : ""}`}
                menu={menuOf(folder)}
                region={t("sources.folders.actions", { name })}
              >
                <span className="px-folders-icon" aria-hidden>
                  {folder.state === "reading" ? (
                    <Logo working decorative size={18} />
                  ) : folder.state === "missing" ? (
                    <FolderX size={18} strokeWidth={1.75} />
                  ) : (
                    <Folder size={18} strokeWidth={1.75} />
                  )}
                </span>
                <span className="px-folders-name">
                  <b title={folder.path}>{name}</b>
                  <small>{line(folder)}</small>
                </span>
                <MenuButton
                  className="px-folders-dots"
                  size="sm"
                  menu={menuOf(folder)}
                  label={t("sources.folders.actions", { name })}
                />
                {folder.state === "missing" || note ? (
                  <span className="px-folders-extra">
                    {note ? (
                      <span className="px-folders-error" role="alert">
                        {note.text}
                      </span>
                    ) : null}
                    {folder.state === "missing" ? (
                      <span className="px-folders-fixes">
                        <Button variant="secondary" size="sm" onClick={() => void find(folder)}>
                          {t("sources.folders.find")}
                        </Button>
                        {note?.relink ? (
                          <Button variant="ghost" size="sm" onClick={() => void linkAsNew(folder, note.relink!)}>
                            {t("sources.folders.linkAsNew")}
                          </Button>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </MenuItemArea>
            );
          })}
        </ul>
        <div className="px-folders-foot">
          <p>
            {t("sources.folders.readOnly")}
            {added ? ` ${t("sources.folders.added", { count: added })}` : ""}
          </p>
          <Button variant="ghost" size="sm" onClick={onLink}>
            <FolderPlus size={14} strokeWidth={1.75} aria-hidden />
            {t("sources.shelf.linkAnother")}
          </Button>
        </div>
      </Popover>
    </>
  );
}
