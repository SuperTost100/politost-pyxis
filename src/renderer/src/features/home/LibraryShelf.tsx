import { useQueryClient } from "@tanstack/react-query";
import { Modal, Tooltip, type MenuProps } from "antd";
import { AlertCircle, Check } from "lucide-react";
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { isPdfPasswordError } from "@shared/source-errors";
import { Button } from "../../components/Button";
import { MenuButton, useItemMenu } from "../../components/ItemMenu";
import { Logo } from "../../components/Logo";
import { invoke } from "../../lib/ipc";
import { refreshSubjects } from "../../lib/refreshSubjects";
import { newCardPath } from "../flashcards/FlashcardsHome";
import { jobErrorKey } from "../jobs/jobErrors";
import { isUnsorted, NewSubjectDialog, SubjectPicker, UnsortedGroup } from "./LibrarySubjects";
import { bookLabel, byShelfOrder, coverColour, coverKind, needsStudent, nextPickerRow, placeWhenReady, PROBLEM } from "./shelf";
import "./LibraryShelf.css";

export type LibrarySource = RequestOutput<"sources.list">[number];
type Subject = RequestOutput<"subjects.list">[number];

/** What a file's menu and its cover do, other than moving it, which the shelf does itself. */
export type ShelfHandlers = {
  open: (source: LibrarySource) => void;
  act: (source: LibrarySource, key: string) => void;
};

const messageKeyOf = (err: unknown): string =>
  err && typeof err === "object" && "messageKey" in err
    ? String((err as { messageKey: unknown }).messageKey)
    : "sources.importFailed";

/** How many covers a shelf shows before "Mostra tutti": two rows at the widest page, so a big subject is no wall. */
const SHELF_CAP = 14;
/** How many rows "Da sistemare" shows before "Mostra tutti", so twenty files to sort do not push the shelves away. */
const UNSORTED_CAP = 8;

/**
 * How a moved file's new cover arrives, and what gets focus once it has landed. A file that left "Da sistemare" grows
 * on its shelf where it lands (`grow`); one moved from another shelf comes out of the box it had there (`from`).
 */
type Landing = { from?: DOMRect; grow?: boolean; focus: "cover" | { picker: string } | null };

/** How long a row of "Da sistemare" takes to fade and close once its file has a subject. */
const ROW_EXIT_MS = 420;
const STILL = "(prefers-reduced-motion: reduce)";

/**
 * The Library by subject: "Da sistemare" on top while some files have no subject, then one card per subject with its
 * files as covers on a shelf. Each cover, row and subject has one menu, opened by its dots and by a right-click.
 */
export function LibraryShelf({
  sources,
  all,
  subjects,
  filtering,
  selectedId,
  newVersions,
  refreshBusy,
  bookBusy,
  handlers,
  addButton,
  subjectsFailed = false,
  onError,
}: {
  /** The files that match the search and the type filter. */
  sources: LibrarySource[];
  /** Every file in the Library, for the counts and the subjects' "Materia nuova" note. */
  all: LibrarySource[];
  subjects: Subject[];
  /** A search or filter narrows the list: empty subjects and the cap step aside. */
  filtering: boolean;
  selectedId: string | null;
  newVersions: Map<string, string>;
  refreshBusy: boolean;
  bookBusy: string | null;
  handlers: RefObject<ShelfHandlers | null>;
  /** The page's "Aggiungi file", where focus goes when the last subject is deleted. */
  addButton: RefObject<HTMLElement | null>;
  /** The subjects could not be read: files that have one still show, in a group of their own. */
  subjectsFailed?: boolean;
  onError: (key: string) => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [modal, modalContext] = Modal.useModal();
  const [naming, setNaming] = useState<LibrarySource | null>(null);
  const [said, setSaid] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  // The subject whose name is being edited now, for an answer that arrives after the student went on to another.
  const renamingNow = useRef<string | null>(null);
  renamingNow.current = renaming;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [unsortedOpen, setUnsortedOpen] = useState(false);
  const landing = useRef(new Map<string, Landing>());
  // Rows of "Da sistemare" whose file just got a subject: they stay, fading and closing in place, until their motion ends.
  const [leaving, setLeaving] = useState<ReadonlyMap<string, { source: LibrarySource; at: number }>>(() => new Map());
  // Files whose move was accepted and whose refreshed list has not arrived: they are out of "Da sistemare" already, so a
  // slow refresh cannot bring their row back after it closed.
  const [moved, setMoved] = useState<ReadonlySet<string>>(() => new Set());
  const pendingFocus = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const detachedId = useId();

  // A file can reach a subject this page has not read yet (a sort or a folder made it): the subjects are read again.
  const known = new Set(subjects.map((subject) => subject.id));
  const unknown = all.some((source) => source.subjectId && !known.has(source.subjectId));
  useEffect(() => {
    // Not while the subjects cannot be read: the page offers Try again, and asking again here would only repeat the failure.
    if (unknown && !subjectsFailed) void client.invalidateQueries({ queryKey: ["subjects"] });
  }, [unknown, subjectsFailed, client]);

  // A file that just got its subject, from Pyxis or from the student, lands on its shelf with a tint that fades.
  const lastSubject = useRef<Map<string, string | null> | null>(null);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const before = lastSubject.current;
    lastSubject.current = new Map(all.map((source) => [source.id, source.subjectId]));
    if (!before) return;
    const landed = all.filter((source) => source.subjectId && before.has(source.id) && before.get(source.id) !== source.subjectId);
    if (!landed.length) return;
    setArrived(new Set(landed.map((source) => source.id)));
    const timer = window.setTimeout(() => setArrived(new Set()), 1_400);
    return () => window.clearTimeout(timer);
  }, [all]);

  // A subject card that appears after the page opened grows in place.
  const seenSubjects = useRef<Set<string> | null>(null);
  const fresh = seenSubjects.current ? subjects.filter((subject) => !seenSubjects.current!.has(subject.id)) : [];
  useEffect(() => {
    seenSubjects.current = new Set(subjects.map((subject) => subject.id));
  }, [subjects]);

  // Focus that waits for its element to be drawn: the next row's picker, or a subject's dots after a rename or delete.
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    const element = root.current?.querySelector<HTMLElement>(target);
    if (element) {
      pendingFocus.current = null;
      element.focus();
    }
  });

  const unsorted = sources
    .filter((source) => (!source.subjectId || isUnsorted(source)) && !moved.has(source.id))
    .sort(byShelfOrder);
  const unsortedShown = unsortedOpen || filtering ? unsorted : unsorted.slice(0, UNSORTED_CAP);
  // A row that is leaving stays where it was in the list while the files have already moved on without it.
  const goneRows = [...leaving.values()]
    .filter(({ source }) => !unsortedShown.some((row) => row.id === source.id))
    .sort((a, b) => a.at - b.at);
  const unsortedRows = [...unsortedShown];
  for (const { source, at } of goneRows) unsortedRows.splice(Math.min(at, unsortedRows.length), 0, source);
  const bySubject = new Map<string, LibrarySource[]>();
  for (const source of sources) {
    if (!source.subjectId || isUnsorted(source)) continue;
    const list = bySubject.get(source.subjectId) ?? [];
    list.push(source);
    bySubject.set(source.subjectId, list);
  }
  const counts = new Map<string, number>();
  for (const source of all) if (source.subjectId) counts.set(source.subjectId, (counts.get(source.subjectId) ?? 0) + 1);
  const unsortedTotal = all.filter((source) => (!source.subjectId || isUnsorted(source)) && !moved.has(source.id)).length;
  // How many files of each subject Pyxis made the subject for, so its note can say "these 3 files".
  const madeFor = new Map<string, number>();
  for (const source of all)
    if (source.sort === "created" && source.subjectId) madeFor.set(source.subjectId, (madeFor.get(source.subjectId) ?? 0) + 1);

  /**
   * Moves a file to a subject: the student's choice from "Sposta in", "Da sistemare" or "Nuova materia…". The new
   * cover comes out of where the file was, focus goes where the student can go on, and a screen reader hears where
   * it went.
   */
  async function move(
    source: LibrarySource,
    to: { subjectId: string } | { name: string },
    focus: Landing["focus"],
    /** The dialog that named the subject shows a refusal beside its field, so it gets the error instead of the page. */
    rethrow = false,
  ) {
    // A file in "Da sistemare" has no cover to come out of: its row closes where it is and its cover grows on its shelf.
    const fromRow = !source.subjectId || isUnsorted(source);
    const from = fromRow
      ? undefined
      : root.current?.querySelector(`[data-source-id="${CSS.escape(source.id)}"] .px-cover-art`)?.getBoundingClientRect();
    try {
      const subject = await invoke("sources.move", { sourceId: source.id, ...to });
      landing.current.set(source.id, { from, grow: fromRow, focus });
      if (fromRow) setMoved((current) => new Set(current).add(source.id));
      const at = unsortedShown.findIndex((row) => row.id === source.id);
      if (fromRow && at >= 0 && !window.matchMedia(STILL).matches)
        setLeaving((current) => new Map(current).set(source.id, { source, at }));
      setSaid(t("sources.shelf.moved", { name: subject.name }));
      // A shelf shows its first covers only. A file sorts first while it is read and by title after, so the shelf opens
      // when the file would be behind them once ready, and its cover stays there when the read ends.
      if (placeWhenReady(bySubject.get(subject.id) ?? [], source) >= SHELF_CAP)
        setExpanded((current) => new Set(current).add(subject.id));
      // The next row's choice gets focus from here, not from the new cover, which may not be drawn.
      if (focus && focus !== "cover") pendingFocus.current = `[data-unsorted-id="${CSS.escape(focus.picker)}"] select`;
      try {
        await Promise.all([
          client.invalidateQueries({ queryKey: ["sources"] }),
          client.invalidateQueries({ queryKey: ["subjects"] }),
        ]);
      } finally {
        // The list is read again now: it shows the file sorted, or it still shows it waiting and the row returns.
        setMoved((current) => {
          const next = new Set(current);
          next.delete(source.id);
          return next;
        });
      }
      return subject;
    } catch (err) {
      if (rethrow) throw err;
      onError(messageKeyOf(err));
      return null;
    }
  }
  /** After a choice in "Da sistemare": a shown row that has a picker, or the moved cover when none has one. */
  function afterUnsorted(source: LibrarySource): Landing["focus"] {
    const next = nextPickerRow(unsortedShown, source.id);
    return next ? { picker: next } : "cover";
  }
  function onLanded(id: string): Landing | undefined {
    const land = landing.current.get(id);
    landing.current.delete(id);
    return land;
  }
  const fileAct = (source: LibrarySource, key: string, fromUnsorted: boolean) => {
    if (key === "move-new") setNaming(source);
    else if (key.startsWith("move:"))
      void move(source, { subjectId: key.slice(5) }, fromUnsorted ? afterUnsorted(source) : "cover");
    else handlers.current?.act(source, key);
  };

  async function rename(subject: Subject, next: string): Promise<string | null> {
    if (!next || next === subject.name) {
      setRenaming(null);
      pendingFocus.current = `[data-subject-id="${CSS.escape(subject.id)}"] .px-shelf-subject-dots`;
      return null;
    }
    try {
      const renamed = await invoke("subjects.rename", { id: subject.id, name: next });
      setSaid(t("sources.shelf.renamed", { name: renamed.name }));
      // The answer closes the field and takes the focus back only while this subject's is the edit that is open.
      if (renamingNow.current === subject.id) {
        setRenaming(null);
        pendingFocus.current = `[data-subject-id="${CSS.escape(subject.id)}"] .px-shelf-subject-dots`;
      }
      void refreshSubjects(client);
      return null;
    } catch (err) {
      return messageKeyOf(err);
    }
  }
  function remove(subject: Subject, index: number) {
    void modal.confirm({
      title: t("sources.shelf.deleteTitle", { name: subject.name }),
      content: t("sources.shelf.deleteBody"),
      okText: t("sources.shelf.deleteConfirm"),
      okButtonProps: { danger: true },
      cancelText: t("sources.sort.cancel"),
      autoFocusButton: "cancel",
      onOk: async () => {
        try {
          await invoke("subjects.remove", { id: subject.id, onlyEmpty: true });
        } catch (err) {
          onError(messageKeyOf(err));
          return;
        }
        setSaid(t("sources.shelf.deleted", { name: subject.name }));
        const neighbour = subjects[index + 1] ?? subjects[index - 1];
        if (neighbour) pendingFocus.current = `[data-subject-id="${CSS.escape(neighbour.id)}"] .px-shelf-subject-dots`;
        await refreshSubjects(client);
        if (!neighbour) (addButton.current?.querySelector("button") ?? addButton.current)?.focus();
      },
    });
  }

  const shownSubjects = filtering ? subjects.filter((subject) => bySubject.has(subject.id)) : subjects;
  // With the subjects unread, a file that has one is in no card: it shows in a group of its own, so it is still there.
  const detached = subjectsFailed
    ? sources.filter((source) => source.subjectId && !isUnsorted(source) && !known.has(source.subjectId)).sort(byShelfOrder)
    : [];
  return (
    <div className="px-shelves" ref={root}>
      {modalContext}
      <p className="visually-hidden" role="status">
        {said}
      </p>
      <NewSubjectDialog
        source={naming}
        onClose={() => setNaming(null)}
        onMove={async (source, name) => {
          const focus = isUnsorted(source) || !source.subjectId ? afterUnsorted(source) : "cover";
          await move(source, { name }, focus, true);
        }}
      />
      {unsorted.length || goneRows.length ? (
        <UnsortedGroup
          sources={[...unsorted, ...goneRows.map((row) => row.source)]}
          more={
            unsorted.length > UNSORTED_CAP && !filtering ? (
              <Button variant="secondary" size="sm" expanded={unsortedOpen} onClick={() => setUnsortedOpen((open) => !open)}>
                {unsortedOpen ? t("sources.shelf.showFewer") : t("sources.shelf.showAll", { count: unsorted.length })}
              </Button>
            ) : null
          }
        >
          {unsortedRows.map((source) => (
            <UnsortedRow
              key={source.id}
              source={source}
              leaving={leaving.has(source.id)}
              onGone={() =>
                setLeaving((current) => {
                  const next = new Map(current);
                  next.delete(source.id);
                  return next;
                })
              }
              subjects={subjects}
              selected={source.id === selectedId}
              menu={fileMenu(source, subjects, t, { refreshBusy, newVersion: newVersions.get(source.id) })}
              newVersion={newVersions.get(source.id)}
              bookBusy={bookBusy === source.id}
              onOpen={() => handlers.current?.open(source)}
              onAct={(key) => fileAct(source, key, true)}
              onPick={(subjectId) => void move(source, { subjectId }, afterUnsorted(source))}
              onNewSubject={() => setNaming(source)}
            />
          ))}
        </UnsortedGroup>
      ) : null}
      {detached.length ? (
        <section className="px-shelf-subject" aria-labelledby={detachedId}>
          <div className="px-shelf-subject-head">
            <h2 id={detachedId} className="px-shelf-subject-name">
              {t("sources.shelf.detachedTitle")}
            </h2>
          </div>
          <ul className="px-shelf">
            {detached.map((source) => (
              <Cover
                key={source.id}
                source={source}
                colour={coverColour(source.subjectId!)}
                selected={source.id === selectedId}
                arrived={false}
                menu={fileMenu(source, subjects, t, { refreshBusy, newVersion: newVersions.get(source.id) })}
                newVersion={newVersions.get(source.id)}
                bookBusy={bookBusy === source.id}
                onOpen={() => handlers.current?.open(source)}
                onAct={(key) => fileAct(source, key, false)}
                onLanded={onLanded}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {shownSubjects.length ? (
        <div className="px-shelf-subjects">
          {shownSubjects.map((subject) => {
            const files = (bySubject.get(subject.id) ?? []).sort(byShelfOrder);
            const open = filtering || expanded.has(subject.id);
            const shown = open ? files : files.slice(0, SHELF_CAP);
            const count = counts.get(subject.id) ?? 0;
            const made = madeFor.get(subject.id) ?? 0;
            return (
              <SubjectCard
                key={subject.id}
                subject={subject}
                index={subjects.indexOf(subject)}
                count={count}
                fresh={fresh.includes(subject)}
                made={made}
                renaming={renaming === subject.id}
                hasFiles={all.length > 0}
                hasUnsorted={unsortedTotal > 0}
                onRename={() => setRenaming(subject.id)}
                onRenameDone={(next) => rename(subject, next)}
                onRenameCancel={() => {
                  setRenaming(null);
                  pendingFocus.current = `[data-subject-id="${CSS.escape(subject.id)}"] .px-shelf-subject-dots`;
                }}
                onNewMap={() => navigate(`/maps?subject=${encodeURIComponent(subject.id)}&new=1`)}
                onNewCards={() => navigate(newCardPath("pyxis", subject.id))}
                onDelete={(index) => remove(subject, index)}
                ahead={
                  // With covers behind "Mostra tutti", the count line says the files that need the student come first.
                  !open && files.length > SHELF_CAP && files.some(needsStudent)
                    ? t("sources.shelf.needsFirst", { count: files.filter(needsStudent).length })
                    : undefined
                }
                more={
                  files.length > SHELF_CAP && !filtering ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      expanded={open}
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (open) next.delete(subject.id);
                          else next.add(subject.id);
                          return next;
                        })
                      }
                    >
                      {open ? t("sources.shelf.showFewer") : t("sources.shelf.showAll", { count: files.length })}
                    </Button>
                  ) : null
                }
              >
                {shown.length ? (
                  <ul className="px-shelf" aria-label={t("sources.shelf.files", { name: subject.name })}>
                    {shown.map((source) => (
                      <Cover
                        key={source.id}
                        source={source}
                        colour={coverColour(subject.id)}
                        selected={source.id === selectedId}
                        arrived={arrived.has(source.id)}
                        menu={fileMenu(source, subjects, t, { refreshBusy, newVersion: newVersions.get(source.id) })}
                        newVersion={newVersions.get(source.id)}
                        bookBusy={bookBusy === source.id}
                        onOpen={() => handlers.current?.open(source)}
                        onAct={(key) => fileAct(source, key, false)}
                        onLanded={onLanded}
                      />
                    ))}
                  </ul>
                ) : null}
              </SubjectCard>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** The items of a file's menu, the same on its cover and its row in "Da sistemare". */
function fileMenu(
  source: LibrarySource,
  subjects: Subject[],
  t: (key: string, options?: Record<string, unknown>) => string,
  state: { refreshBusy: boolean; newVersion?: string },
): NonNullable<MenuProps["items"]> {
  return [
    { key: "details", label: t("sources.details") },
    { key: "rename", label: t("sources.rename") },
    {
      key: "move",
      label: t("sources.sort.moveTo"),
      children: [
        ...subjects.map((subject) => ({
          key: `move:${subject.id}`,
          label: subject.name,
          icon: subject.id === source.subjectId ? <Check size={14} aria-hidden /> : undefined,
          disabled: subject.id === source.subjectId,
        })),
        ...(subjects.length ? [{ type: "divider" as const }] : []),
        { key: "move-new", label: t("sources.sort.newSubject") },
      ],
    },
    // A locked PDF asks for its password, and a free book with a newer version updates, from here.
    ...(source.errorJobId && isPdfPasswordError(source.error)
      ? [{ key: "unlock", label: t("sources.pdfPassword.enter") }]
      : []),
    ...(state.newVersion !== undefined ? [{ key: "update-book", label: t("sources.shelf.updateBook") }] : []),
    // A file read in place from a linked folder changes there, and Pyxis reads it again by itself.
    { key: "replace", label: t("sources.replace"), disabled: source.linked !== null },
    {
      key: "reextract",
      label: t("sources.reextract"),
      // A smartbook is read from its package and has no stored file to read again.
      disabled: source.kind === "smartbook" || !source.blobSha,
    },
    // Only a source saved from a link has a page to fetch again.
    ...(source.originUrl ? [{ key: "refresh", label: t("sources.refresh"), disabled: state.refreshBusy }] : []),
    { type: "divider" as const },
    { key: "remove", label: t("sources.remove"), danger: true },
  ];
}

/** What a file's cover or row says about its state: reading, failed, missing, or a note such as a new book version. */
function useFileState(source: LibrarySource, newVersion: string | undefined) {
  const { t } = useTranslation();
  const problem = PROBLEM.has(source.status);
  const working = !problem && source.status !== "ready";
  const notes = [
    source.linked?.missing ? t("sources.linked.missing", { folder: source.linked.folder }) : null,
    source.error ? t(jobErrorKey(source.error)) : null,
    source.syllabusOff ? t("sources.offSyllabusListed", { count: source.syllabusOff }) : null,
    newVersion !== undefined ? t("books.newVersionNamed", { version: newVersion }) : null,
  ].filter((note): note is string => Boolean(note));
  const status =
    source.status === "ready" ? null : t(`sources.status.${source.status}`, { defaultValue: source.status });
  return { problem, working, status, notes, flagged: problem || Boolean(source.linked?.missing) };
}

/**
 * What a file needs from the student to be read or kept current, in place: a locked PDF's password, and a free book's
 * update. The file's menu has both too.
 */
function FileActions({
  source,
  newVersion,
  bookBusy,
  onAct,
}: {
  source: LibrarySource;
  newVersion: string | undefined;
  bookBusy: boolean;
  onAct: (key: string) => void;
}) {
  const { t } = useTranslation();
  const locked = Boolean(source.errorJobId && isPdfPasswordError(source.error));
  if (!locked && newVersion === undefined) return null;
  return (
    <span className="px-file-actions">
      {locked ? (
        <button
          type="button"
          className="px-file-action"
          aria-label={t("sources.pdfPassword.enterNamed", { title: source.title })}
          onClick={() => onAct("unlock")}
        >
          {t("sources.pdfPassword.enter")}
        </button>
      ) : null}
      {newVersion !== undefined ? (
        <button
          type="button"
          className="px-file-action"
          disabled={bookBusy}
          aria-label={t(bookBusy ? "books.updatingNamed" : "books.updateNamed", { title: source.title })}
          onClick={() => onAct("update-book")}
        >
          {bookBusy ? <Logo working decorative size={14} /> : null}
          {t(bookBusy ? "books.adding" : "books.update")}
        </button>
      ) : null}
    </span>
  );
}

/** The picture of a file: a book in its subject's colour, slides, an exam paper, a photo or a stack of pages. */
function CoverArt({ source, colour, label }: { source: LibrarySource; colour?: number; label?: string }) {
  const kind = coverKind(source);
  const style = colour ? ({ "--cover": `var(--cover-${colour})` } as CSSProperties) : undefined;
  return (
    <span className={`px-cover-art is-${kind}`} style={style} aria-hidden>
      {/* Printed by CSS, so the cover's button is named by the file's title alone. */}
      {kind === "book" && label ? <span className="px-cover-book-title" data-label={bookLabel(label)} /> : null}
    </span>
  );
}

/**
 * One file on a shelf: its cover, its title and, when it is not ready, its state. The cover opens the file's details;
 * the dots, shown on hover and focus, and a right-click open its menu.
 */
const Cover = memo(function Cover({
  source,
  colour,
  selected,
  arrived,
  menu,
  newVersion,
  bookBusy,
  onOpen,
  onAct,
  onLanded,
}: {
  source: LibrarySource;
  colour: number;
  selected: boolean;
  arrived: boolean;
  menu: NonNullable<MenuProps["items"]>;
  newVersion: string | undefined;
  bookBusy: boolean;
  onOpen: () => void;
  onAct: (key: string) => void;
  onLanded: (id: string) => Landing | undefined;
}) {
  const { t } = useTranslation();
  const state = useFileState(source, newVersion);
  const item = useRef<HTMLLIElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const menuProps: MenuProps = { items: menu, onClick: ({ key }) => onAct(key) };
  const itemMenu = useItemMenu({ menu: menuProps, region: t("sources.actionsColumn") });
  // A file the student just moved here comes out of where it was, and takes focus when the move came from its menu.
  useLayoutEffect(() => {
    const land = onLanded(source.id);
    if (!land) return;
    if (land.focus === "cover") openRef.current?.focus();
    const art = item.current?.querySelector<HTMLElement>(".px-cover-art");
    if (!art || window.matchMedia(STILL).matches) return;
    if (land.grow) {
      // The picture grows where it lands, from its own centre. `scale` is its own property, so a book's tilt stays.
      art.animate([{ scale: "0.4", opacity: 0 }, { scale: "1", opacity: 1 }], { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
      return;
    }
    if (!land.from) return;
    const to = art.getBoundingClientRect();
    // The shelf draws its pictures with `zoom`, which also scales the lengths of a transform on them: the path is
    // measured in window pixels, so it is divided by that zoom, and starts at the picture's corner.
    const zoom = Number.parseFloat(getComputedStyle(art).zoom) || 1;
    const dx = (land.from.left - to.left) / zoom;
    const dy = (land.from.top - to.top) / zoom;
    if (Math.abs(dx) + Math.abs(dy) < 2) return;
    art.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(${land.from.width / to.width})`, transformOrigin: "0 0" }, { transform: "none", transformOrigin: "0 0" }],
      { duration: 320, easing: "cubic-bezier(0.77, 0, 0.175, 1)" },
    );
  }, []);
  const detail = [state.status, ...state.notes].filter(Boolean).join(". ");
  const stateId = useId();
  // The title shows whole in a tooltip on hover and on keyboard focus when the cover cuts it, or when there is a state to say.
  const titleText = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState(false);
  useEffect(() => {
    if (itemMenu.open) setTip(false);
  }, [itemMenu.open]);
  return (
    <li
      ref={item}
      className={["px-cover", selected ? "is-selected" : "", arrived ? "is-arrived" : "", itemMenu.popup ? "is-menu" : ""]
        .filter(Boolean)
        .join(" ")}
      data-source-id={source.id}
      {...itemMenu.bind}
    >
      <Tooltip
        open={tip}
        trigger={["hover", "focus"]}
        placement="bottom"
        onOpenChange={(next) => {
          const text = titleText.current;
          setTip(next && (detail !== "" || (text !== null && text.scrollHeight > text.clientHeight + 1)));
        }}
        title={
          <span className="px-cover-tip">
            <span>{source.title}</span>
            {detail ? <span className="px-cover-tip-state">{detail}</span> : null}
          </span>
        }
      >
        <button
          ref={openRef}
          type="button"
          className="px-cover-open"
          data-source-open
          onClick={onOpen}
          onKeyDown={(event) => {
            if (event.key === "Escape" && tip) {
              event.stopPropagation();
              setTip(false);
            }
          }}
          // The title names the cover; its state, under it, is read after it as a description.
          aria-describedby={detail ? stateId : undefined}
        >
          <span className="px-cover-frame">
            <CoverArt source={source} colour={colour} label={source.subject ?? undefined} />
            {state.working || bookBusy ? (
              <span className="px-cover-badge">
                <Logo working decorative size={16} />
              </span>
            ) : state.flagged ? (
              <span className="px-cover-badge is-problem">
                <AlertCircle size={16} strokeWidth={1.75} aria-hidden />
              </span>
            ) : null}
          </span>
          <span ref={titleText} className="px-cover-title">
            {source.title}
          </span>
        </button>
      </Tooltip>
      {detail ? (
        <span id={stateId} className={state.flagged ? "px-cover-state is-problem" : "px-cover-state"}>
          {[state.status, ...state.notes].filter(Boolean).map((part) => (
            <span key={part}>{part}</span>
          ))}
        </span>
      ) : null}
      <FileActions source={source} newVersion={newVersion} bookBusy={bookBusy} onAct={onAct} />
      <MenuButton
        menu={menuProps}
        className="px-cover-menu"
        label={t("sources.actionsFor", { title: source.title })}
        region={t("sources.actionsColumn")}
      />
      {itemMenu.popup}
    </li>
  );
});

/** A file without a subject: its picture, name and kind, the choice of subject (or Pyxis choosing it) and its menu. */
function UnsortedRow({
  source,
  leaving,
  onGone,
  subjects,
  selected,
  menu,
  newVersion,
  bookBusy,
  onOpen,
  onAct,
  onPick,
  onNewSubject,
}: {
  source: LibrarySource;
  /** The file has a subject now: the row fades and closes where it is, then calls `onGone`. Nothing in it works. */
  leaving: boolean;
  onGone: () => void;
  subjects: Subject[];
  selected: boolean;
  menu: NonNullable<MenuProps["items"]>;
  newVersion: string | undefined;
  bookBusy: boolean;
  onOpen: () => void;
  onAct: (key: string) => void;
  onPick: (subjectId: string) => void;
  onNewSubject: () => void;
}) {
  const { t } = useTranslation();
  const state = useFileState(source, newVersion);
  const menuProps: MenuProps = { items: menu, onClick: ({ key }) => onAct(key) };
  const itemMenu = useItemMenu({ menu: menuProps, region: t("sources.actionsColumn") });
  const row = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    const node = row.current;
    if (!leaving || !node) return;
    const height = node.offsetHeight;
    node.style.overflow = "hidden";
    const animation = node.animate(
      [
        { opacity: 1, height: `${height}px`, minHeight: `${height}px` },
        { opacity: 0, height: `${height}px`, minHeight: `${height}px`, offset: 0.52 },
        { opacity: 0, height: "0px", minHeight: "0px", paddingTop: "0px", paddingBottom: "0px", marginTop: "0px" },
      ],
      { duration: ROW_EXIT_MS, easing: "cubic-bezier(0.77, 0, 0.175, 1)", fill: "forwards" },
    );
    animation.onfinish = onGone;
    return () => animation.cancel();
    // The motion starts once, when the row starts to leave.
  }, [leaving]);
  const meta = [
    t(`sources.kind.${source.kind}`, { defaultValue: source.kind }),
    source.sections ? t("sources.sectionCount", { count: source.sections }) : null,
    state.status,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li
      ref={row}
      className={["px-unsorted-row", selected ? "is-selected" : "", itemMenu.popup ? "is-menu" : ""].filter(Boolean).join(" ")}
      data-source-id={source.id}
      data-unsorted-id={source.id}
      {...(leaving ? { "data-leaving": "", "aria-hidden": true, inert: true } : {})}
      {...itemMenu.bind}
    >
      <span className="px-unsorted-art">
        <CoverArt source={source} />
      </span>
      <span className="px-unsorted-name">
        <button type="button" className="px-unsorted-open" data-source-open onClick={onOpen}>
          <span className="body-strong">{source.title}</span>
        </button>
        <span className={state.flagged ? "small px-unsorted-meta is-problem" : "small px-unsorted-meta"}>{meta}</span>
        {state.notes.map((note) => (
          <span key={note} className={state.flagged ? "small px-unsorted-meta is-problem" : "small px-unsorted-meta"}>
            {note}
          </span>
        ))}
        <FileActions source={source} newVersion={newVersion} bookBusy={bookBusy} onAct={onAct} />
      </span>
      {source.sort === "working" ? (
        <p className="small px-library-sorting" role="status">
          <Logo working decorative size={16} />
          {t("sources.sort.working")}
        </p>
      ) : (
        <SubjectPicker source={source} subjects={subjects} onPick={onPick} onNewSubject={onNewSubject} />
      )}
      <MenuButton
        menu={menuProps}
        className="px-unsorted-menu"
        label={t("sources.actionsFor", { title: source.title })}
        region={t("sources.actionsColumn")}
      />
      {itemMenu.popup}
    </li>
  );
}

/**
 * A subject: its name, how many files it has and its menu, then its shelf. A screen reader hears it as a region named
 * by both. Its menu renames it in place, starts a map or flashcards of it, and deletes it once nothing has it.
 */
function SubjectCard({
  subject,
  index,
  count,
  ahead,
  fresh,
  made,
  renaming,
  hasFiles,
  hasUnsorted,
  onRename,
  onRenameDone,
  onRenameCancel,
  onNewMap,
  onNewCards,
  onDelete,
  more,
  children,
}: {
  subject: Subject;
  index: number;
  count: number;
  /** A note after the count: the files that need the student come first, while some are behind "Mostra tutti". */
  ahead?: string;
  fresh: boolean;
  /** Files Pyxis made this subject for, which its "Materia nuova" note counts. */
  made: number;
  renaming: boolean;
  /** The Library has a file somewhere; with none, the page above the cards already says to add one. */
  hasFiles: boolean;
  hasUnsorted: boolean;
  onRename: () => void;
  /** Saves the new name; resolves with the key of what refused it, or null. */
  onRenameDone: (name: string) => Promise<string | null>;
  onRenameCancel: () => void;
  onNewMap: () => void;
  onNewCards: () => void;
  onDelete: (index: number) => void;
  more: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const headId = useId();
  const countId = useId();
  const errorId = useId();
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  const saving = useRef(false);
  const empty = count === 0 && !subject.inUse;
  const menu: MenuProps = {
    items: [
      { key: "rename", label: t("sources.sort.rename") },
      { key: "map", label: t("sources.shelf.newMap") },
      { key: "cards", label: t("sources.shelf.newCards") },
      ...(empty ? [{ type: "divider" as const }, { key: "delete", label: t("sources.shelf.delete"), danger: true }] : []),
    ],
    onClick: ({ key }) => {
      if (key === "rename") {
        setError(null);
        onRename();
      } else if (key === "map") onNewMap();
      else if (key === "cards") onNewCards();
      else if (key === "delete") onDelete(index);
    },
  };
  const itemMenu = useItemMenu({ menu, region: t("sources.shelf.subjectActions", { name: subject.name }) });
  const save = async (value: string) => {
    if (saving.current) return;
    saving.current = true;
    const refused = await onRenameDone(value.trim());
    saving.current = false;
    setError(refused);
  };
  return (
    <section
      className={["px-shelf-subject", count === 0 ? "is-empty" : "", fresh ? "is-fresh" : "", itemMenu.popup ? "is-menu" : ""]
        .filter(Boolean)
        .join(" ")}
      data-subject-id={subject.id}
      aria-labelledby={`${headId} ${countId}`}
    >
      <div className="px-shelf-subject-head" {...itemMenu.bind}>
        {renaming ? (
          <input
            className="px-ctl-field px-shelf-subject-rename"
            aria-label={t("sources.sort.renameLabel", { name: subject.name })}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            autoFocus
            autoComplete="off"
            maxLength={120}
            defaultValue={subject.name}
            onFocus={(event) => {
              cancelled.current = false;
              event.currentTarget.select();
            }}
            onBlur={(event) => {
              if (cancelled.current) return;
              void save(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                void save(event.currentTarget.value);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                cancelled.current = true;
                setError(null);
                onRenameCancel();
              }
            }}
          />
        ) : null}
        {/* A double-click renames in place, like Rinomina in the menu. */}
        <h2
          id={headId}
          className="px-shelf-subject-name"
          hidden={renaming}
          onDoubleClick={() => {
            setError(null);
            onRename();
          }}
        >
          {subject.name}
        </h2>
        <span id={countId} className="small px-shelf-subject-count">
          {count ? t("sources.shelf.count", { count }) : t("sources.shelf.countNone")}
        </span>
        {ahead ? <span className="small px-shelf-subject-count">· {ahead}</span> : null}
        <MenuButton
          menu={menu}
          className="px-shelf-subject-dots"
          label={t("sources.shelf.subjectActions", { name: subject.name })}
          region={t("sources.shelf.subjectActions", { name: subject.name })}
        />
        {itemMenu.popup}
      </div>
      {error ? (
        <p id={errorId} className="small px-shelf-subject-error" role="alert">
          {t(error)}
        </p>
      ) : null}
      {made > 0 && !renaming ? (
        <div className="px-library-newsubject">
          <p className="small">
            <strong>{t("sources.sort.createdTitle")}</strong> {t("sources.sort.created", { count: made })}
          </p>
          <Button
            variant="ghost"
            size="sm"
            icon="pencil-line"
            aria-label={t("sources.sort.renameNamed", { name: subject.name })}
            onClick={() => {
              setError(null);
              onRename();
            }}
          >
            {t("sources.sort.rename")}
          </Button>
        </div>
      ) : null}
      {children ?? (
        <p className="small px-shelf-subject-none">
          {!hasFiles
            ? t("sources.shelf.emptySubjectNoFiles")
            : hasUnsorted
              ? t("sources.shelf.emptySubject")
              : t("sources.shelf.emptySubjectNoUnsorted")}
        </p>
      )}
      {more ? <div className="px-shelf-subject-more">{more}</div> : null}
    </section>
  );
}
