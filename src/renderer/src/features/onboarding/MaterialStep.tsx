import { useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "antd";
import { ArrowRight, Folder, FolderPlus, FolderX, Hourglass, LoaderCircle, Lock } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { LinkMode } from "@shared/linked-folders";
import { MAX_FOLDER_DEPTH, MAX_FOLDER_FILES } from "@shared/source-types";
import type { RequestOutput } from "../../../../shared/ipc";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";
import { useSources } from "../../lib/queries";

type LinkedFolder = RequestOutput<"sources.linkFolders">["folders"][number];
type Screen = "choice" | "pick" | "found";
/** What the student changed on a subject row: its name, or that a skipped folder is a subject after all. */
type Edit = { name: string; skipped: boolean };

const editKey = (folderId: string, key: string) => `${folderId}\u0000${key}`;
/** A source still being read: setup says so, and lets the student start anyway. */
const READING = new Set(["queued", "extracting", "indexing", "ocr-queued"]);
/** Marks where a bold folder name goes in a translated sentence. */
const SLOT = "\u0001";

const messageKeyOf = (err: unknown): string =>
  err && typeof err === "object" && "messageKey" in err
    ? String((err as { messageKey: unknown }).messageKey)
    : "sources.linked.errors.failed";

/** "Documenti › Università": the folder and the one that holds it, as the student knows them. */
function placeOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join(" › ") || path;
}

/** A translated sentence with `folder` in bold where the translation puts it. */
function withBold(text: string, folder: string): ReactNode {
  const [before, after] = text.split(SLOT);
  if (after === undefined) return text;
  return (
    <>
      {before}
      <b className="px-found-strong">{folder}</b>
      {after}
    </>
  );
}

/**
 * The last step of setup: how the student keeps their material, where the folder is, and the subjects Pyxis found in
 * it. Folders are linked, not copied: Pyxis reads them in place, starts reading as soon as a folder is chosen, and keeps
 * reading new files later. On setup again the step opens on the folders linked already and their subjects, so the
 * student can rename one, add a folder or just finish. The step owns its title and footer, because each of its three
 * screens has its own.
 */
export function MaterialStep({
  heading,
  again,
  onBack,
  onLeave,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  /** Setup again, which ends back in Settings. */
  again: boolean;
  /** Back to the AI step. */
  onBack: () => void;
  /** Ends setup: on Chiedi, or in Settings on setup again. */
  onLeave: () => void;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const [screen, setScreen] = useState<Screen>("choice");
  const [mode, setMode] = useState<LinkMode>("root");
  const [folders, setFolders] = useState<LinkedFolder[]>([]);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [busy, setBusy] = useState<"linking" | "confirming" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [checked, setChecked] = useState(false);
  // On setup again, whether the folders linked already were read. Until then the step draws nothing, so it never
  // flashes the choice.
  const [loaded, setLoaded] = useState(!again);
  const sources = useSources(folders.length > 0);

  useEffect(() => {
    if (!again) return;
    let live = true;
    invoke("sources.linkedFolders", {})
      .then((linked) => {
        if (!live || !linked.length) return;
        setFolders(linked);
        setMode(linked[0]!.mode);
        setScreen("found");
      })
      // Without the list the step starts at the choice, as a first setup does; a folder linked again is returned as is.
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [again]);

  // Each screen starts at its top with the heading focused, as the steps of setup do. The step's first screen only
  // takes the focus: setup scrolled to the top when the step opened, before the folders were read.
  const shown = useRef(false);
  useEffect(() => {
    if (!loaded) return;
    if (shown.current) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    shown.current = true;
    heading.current?.focus({ preventScroll: true });
  }, [loaded, screen, heading]);

  const go = (next: Screen) => {
    setError(null);
    setScreen(next);
  };

  async function link(paths: string[]) {
    if (!paths.length || busy) return;
    setBusy("linking");
    setError(null);
    try {
      const linked = await invoke("sources.linkFolders", { paths, mode });
      setFolders((current) => [
        ...current.filter((folder) => !linked.folders.some((item) => item.id === folder.id)),
        ...linked.folders,
      ]);
      void client.invalidateQueries({ queryKey: ["sources"] });
      go("found");
    } catch (err) {
      setError(messageKeyOf(err));
    } finally {
      setBusy(null);
    }
  }

  async function pick() {
    setError(null);
    let picked: string[] | null;
    try {
      picked = await window.pyxis.showOpenDialog({
        properties: mode === "subject" ? ["openDirectory", "multiSelections"] : ["openDirectory"],
      });
    } catch (err) {
      // Main could not grant the folder in time (core busy): say so on the screen instead of doing nothing.
      setError(messageKeyOf(err));
      return;
    }
    if (picked?.length) await link(picked);
  }

  async function drop(files: File[]) {
    setError(null);
    let granted: { paths: string[]; skipped: number };
    try {
      granted = await window.pyxis.grantDroppedFolders(files);
    } catch (err) {
      // Too many folders at once, or core did not take the grant in time.
      setError(messageKeyOf(err));
      return;
    }
    if (!granted.paths.length) {
      setError("sources.linked.dropNotFolder");
      return;
    }
    await link(mode === "root" ? granted.paths.slice(0, 1) : granted.paths);
  }

  const rows = folders.flatMap((folder) =>
    folder.subjects.map((subject) => {
      const edit = edits[editKey(folder.id, subject.key)];
      return {
        folder,
        subject,
        name: edit?.name ?? subject.name,
        skipped: edit?.skipped ?? subject.skipped,
      };
    }),
  );
  const subjects = rows.filter((row) => !row.skipped);
  const invalid = subjects.some((row) => !row.name.trim());
  const ids = new Set(folders.map((folder) => folder.id));
  const reading = (sources.data ?? []).some(
    (source) => source.linked && ids.has(source.linked.folderId) && READING.has(source.status),
  );
  const edit = (folderId: string, key: string, patch: Partial<Edit>, base: Edit) =>
    setEdits((current) => ({
      ...current,
      [editKey(folderId, key)]: { ...base, ...current[editKey(folderId, key)], ...patch },
    }));

  async function confirm() {
    setChecked(true);
    if (invalid || busy) return;
    setBusy("confirming");
    setError(null);
    try {
      await invoke("sources.confirmFolders", {
        folders: folders.map((folder) => ({
          folderId: folder.id,
          subjects: rows
            .filter((row) => row.folder.id === folder.id)
            .map((row) => ({
              key: row.subject.key,
              name: row.name.trim() || row.subject.name,
              skipped: row.skipped,
            })),
        })),
      });
      await client.invalidateQueries({ queryKey: ["subjects"] });
      void client.invalidateQueries({ queryKey: ["sources"] });
      onLeave();
    } catch (err) {
      setError(messageKeyOf(err));
      setBusy(null);
    }
  }

  const readOnly = (key: "readOnly" | "readOnlyNew") => (
    <p className="small px-material-copy">
      <Lock size={15} aria-hidden />
      {t(`onboarding.material.${key}`)}
    </p>
  );
  const errorNotice = error ? <Notice tone="danger">{t(error)}</Notice> : null;
  const listFormat = new Intl.ListFormat(i18n.language.startsWith("it") ? "it" : "en-GB", {
    style: "long",
    type: "conjunction",
  });

  let title: string;
  let body: ReactNode;
  let content: ReactNode;
  let footer: ReactNode;
  if (screen === "choice") {
    title = t("onboarding.material.title");
    body = t("onboarding.material.body");
    const choice = (value: LinkMode, tree: ReactNode) => (
      <div className="px-material-choice">
        <h2 className="px-material-title">
          <button
            type="button"
            className="px-material-pick"
            aria-describedby={`material-${value}-body`}
            onClick={() => {
              setMode(value);
              go("pick");
            }}
          >
            {t(`onboarding.material.${value}.title`)}
          </button>
          <ArrowRight size={18} aria-hidden />
        </h2>
        <span className="px-material-tree" aria-hidden>
          {tree}
        </span>
        <p className="px-material-body" id={`material-${value}-body`}>
          {t(`onboarding.material.${value}.body`)}
        </p>
      </div>
    );
    content = (
      <>
        <div className="px-material-choices">
          {choice(
            "root",
            <>
              <span className="is-head">
                <Folder size={16} />
                {t("onboarding.material.example.study")}
              </span>
              {(["one", "two", "three"] as const).map((key) => (
                <span key={key} className="is-sub">
                  <Folder size={16} />
                  {t(`onboarding.material.example.${key}`)}
                </span>
              ))}
              <span className="is-more">{t("onboarding.material.example.more")}</span>
            </>,
          )}
          {choice(
            "subject",
            (["one", "two", "three", "four"] as const).map((key) => (
              <span key={key} className="is-head">
                <Folder size={16} />
                {t(`onboarding.material.example.${key}`)}
              </span>
            )),
          )}
        </div>
        {readOnly("readOnly")}
      </>
    );
    footer = (
      <>
        <span>
          <Button shape="round" onClick={onBack}>
            {t("nav.back")}
          </Button>
        </span>
        <span className="px-onboarding-primary">
          <Button type="text" shape="round" onClick={onLeave}>
            {t("onboarding.later")}
          </Button>
        </span>
      </>
    );
  } else if (screen === "pick") {
    title = t(`onboarding.material.pick.${mode}.title`);
    body = t(`onboarding.material.pick.${mode}.body`);
    const linking = busy === "linking";
    content = (
      <>
        <div
          className={dragging ? "px-material-drop is-dragging" : "px-material-drop"}
          aria-busy={linking}
          onDragEnter={(event) => {
            if (!event.dataTransfer.types.includes("Files") || linking) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("Files") || linking) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "link";
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const files = Array.from(event.dataTransfer.files);
            if (files.length && !linking) void drop(files);
          }}
        >
          <span className="px-material-tree" aria-hidden>
            {mode === "root" ? (
              <>
                <span className="is-head">
                  <Folder size={16} />
                  {t("onboarding.material.example.study")}
                </span>
                {(["one", "two"] as const).map((key) => (
                  <span key={key} className="is-sub">
                    <Folder size={16} />
                    {t(`onboarding.material.example.${key}`)}
                  </span>
                ))}
                <span className="is-more">{t("onboarding.material.example.more")}</span>
              </>
            ) : (
              (["one", "two", "three"] as const).map((key) => (
                <span key={key} className="is-head">
                  <Folder size={16} />
                  {t(`onboarding.material.example.${key}`)}
                </span>
              ))
            )}
          </span>
          <h2 className="px-material-drop-title">
            {dragging ? t("onboarding.material.pick.dropActive") : t(`onboarding.material.pick.${mode}.drop`)}
          </h2>
          <p className="px-material-drop-body" role="status">
            {linking ? (
              <>
                <LoaderCircle className="px-spin" size={16} aria-hidden />
                {t("onboarding.material.pick.reading")}
              </>
            ) : (
              t(`onboarding.material.pick.${mode}.or`)
            )}
          </p>
          <Button type="primary" shape="round" size="large" loading={linking} onClick={() => void pick()}>
            {t(`onboarding.material.pick.${mode}.choose`)}
          </Button>
        </div>
        {errorNotice}
        {readOnly("readOnlyNew")}
      </>
    );
    footer = (
      <span>
        <Button shape="round" disabled={linking} onClick={() => go(folders.length ? "found" : "choice")}>
          {t("nav.back")}
        </Button>
      </span>
    );
  } else {
    const places = folders.map((folder) => placeOf(folder.path));
    title = subjects.length
      ? t("onboarding.material.found.title", { count: subjects.length })
      : t("onboarding.material.found.none");
    body = rows.length
      ? withBold(
          t("onboarding.material.found.body", { count: folders.length, folder: SLOT }),
          listFormat.format(places),
        )
      : withBold(t("onboarding.material.found.empty", { folder: SLOT }), listFormat.format(places));
    const cut = folders.some((folder) => folder.cut.files || folder.cut.depth || folder.cut.entries);
    const unreadable = folders.some((folder) => folder.cut.unreadable);
    content = (
      <>
        {rows.length ? (
          <ul className="px-found" aria-label={t("onboarding.material.found.label")}>
            {rows.map((row) => {
              const id = `subject-${row.folder.id}-${row.subject.key}`;
              const base = { name: row.subject.name, skipped: row.subject.skipped };
              if (row.skipped)
                return (
                  <li key={id} className="is-skip">
                    <span className="px-found-skip">
                      <FolderX size={16} aria-hidden />
                      <span>
                        {withBold(t("onboarding.material.found.skip", { folder: SLOT }), row.subject.folder)}
                      </span>
                    </span>
                    <Button
                      shape="round"
                      size="small"
                      aria-label={t("onboarding.material.found.isSubjectNamed", { folder: row.subject.folder })}
                      onClick={() => edit(row.folder.id, row.subject.key, { skipped: false }, base)}
                    >
                      {t("onboarding.material.found.isSubject")}
                    </Button>
                  </li>
                );
              const empty = checked && !row.name.trim();
              return (
                <li key={id}>
                  <span className="px-found-name">
                    <Input
                      id={id}
                      value={row.name}
                      maxLength={120}
                      status={empty ? "error" : undefined}
                      aria-invalid={empty || undefined}
                      aria-describedby={empty ? `${id}-error` : undefined}
                      aria-label={t("onboarding.material.found.nameLabel", { folder: row.subject.folder })}
                      autoComplete="off"
                      onChange={(event) => edit(row.folder.id, row.subject.key, { name: event.target.value }, base)}
                    />
                    {empty ? (
                      <span className="small px-found-error" id={`${id}-error`}>
                        {t("onboarding.material.found.nameEmpty")}
                      </span>
                    ) : null}
                  </span>
                  <span className="small px-found-from">
                    <Folder size={15} aria-hidden />
                    <span>{t("onboarding.material.found.from", { folder: row.subject.folder })}</span>
                  </span>
                  <span className="small px-found-kinds">
                    {row.subject.kinds.map((kind) => t(`sources.linked.kinds.${kind}`)).join(", ")}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
        {cut ? (
          <Notice tone="warning">
            {t("onboarding.material.found.cut", { files: MAX_FOLDER_FILES, depth: MAX_FOLDER_DEPTH })}
          </Notice>
        ) : null}
        {unreadable ? <Notice tone="warning">{t("sources.folderUnreadable")}</Notice> : null}
        {reading ? (
          <p className="small px-material-reading" role="status">
            <Hourglass size={15} aria-hidden />
            {t("onboarding.material.reading")}
          </p>
        ) : null}
        {errorNotice}
      </>
    );
    footer = (
      <>
        <span>
          {/* Setup again reads the folders afresh when it comes back here. A first setup has no way back once linked. */}
          {again ? (
            <Button shape="round" disabled={busy !== null} onClick={onBack}>
              {t("nav.back")}
            </Button>
          ) : null}
        </span>
        <span className="px-onboarding-primary">
          <Button
            type="text"
            shape="round"
            icon={<FolderPlus size={16} aria-hidden />}
            disabled={busy !== null}
            onClick={() => go("pick")}
          >
            {t("onboarding.material.found.addFolder")}
          </Button>
          <Button
            type="primary"
            shape="round"
            size="large"
            loading={busy === "confirming"}
            onClick={() => void confirm()}
          >
            {t(again ? "onboarding.again.done" : "onboarding.done")}
          </Button>
        </span>
      </>
    );
  }

  if (!loaded) return null;
  return (
    <>
      <div className="px-onboarding-title">
        <h1 className="display" tabIndex={-1} ref={heading}>
          {title}
        </h1>
        <p className="body">{body}</p>
      </div>
      {content}
      <div className="px-onboarding-actions">{footer}</div>
    </>
  );
}
