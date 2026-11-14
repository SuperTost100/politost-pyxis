import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type MenuProps } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Reveal } from "../../components/Controls";
import { useConfirm } from "../../components/Dialog";
import { Icon, type IconName } from "../../components/Icon";
import { MenuButton, MenuItemArea } from "../../components/ItemMenu";
import { Logo } from "../../components/Logo";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";
import {
  deleteBody,
  isMissingActivity,
  resumePath,
  unfinishedDetail,
  unfinishedTitle,
  type UnfinishedEntry,
} from "./unfinishedText";
import "./Unfinished.css";

const unfinishedIcons: Record<UnfinishedEntry["kind"], IconName> = {
  quiz: "list-checks",
  drill: "circle-alert",
  diagnostic: "target",
  redo: "rotate-ccw",
  past: "file-pen",
  review: "layers",
  simulation: "clock",
};

/** The block shows this many, and "Mostra tutte" the rest. */
const SHOWN = 3;

export const unfinishedQuery = (planId: string) => ({
  queryKey: ["unfinished", planId],
  queryFn: () => invoke("plans.unfinished", { planId }),
  // What the student left a moment ago must be there when they come back to the page.
  staleTime: 0,
  // An activity being written changes state on its own.
  refetchInterval: (query: { state: { data?: UnfinishedEntry[] } }) =>
    query.state.data?.some((entry) => entry.state === "writing") ? 2000 : false,
});

/**
 * "Da finire": every quiz, review or simulation of this exam that was started and not handed in, newest first, each with
 * what it is, how far it got and when it was started. The row resumes it; its dots and a right-click open Riprendi and
 * Elimina…. Present only when there is something to finish. See `unfinishedActivities` in core for what counts.
 */
export function UnfinishedSection({ planId }: { planId: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const confirm = useConfirm();
  const list = useQuery(unfinishedQuery(planId));
  const [all, setAll] = useState(false);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [failed, setFailed] = useState<UnfinishedEntry | null>(null);
  const [said, setSaid] = useState("");
  const root = useRef<HTMLElement>(null);
  // After a delete, the focus goes to the row that took the deleted one's place, or out of the block when it closes.
  const focusAt = useRef<number | null>(null);
  const entries = list.data ?? [];
  const now = Date.now();

  useEffect(() => {
    const at = focusAt.current;
    if (at == null || leaving) return;
    focusAt.current = null;
    const rows = root.current?.querySelectorAll<HTMLElement>(".px-unf-open");
    const target = rows?.[Math.min(at, rows.length - 1)];
    if (target) target.focus();
    else
      document
        .querySelector<HTMLElement>(".px-exam-aside button, .px-exam-aside a")
        ?.focus();
  }, [list.data, leaving]);

  // The result of a delete is announced from here, which stays when the block goes with its last row.
  const status = (
    <p className="visually-hidden" role="status">
      {said}
    </p>
  );
  // A list that cannot be read is said so in place: an absent block would look like nothing left to finish.
  const unreadable = list.isError && !list.data;
  if (!entries.length && !failed && !unreadable) return status;

  async function remove(entry: UnfinishedEntry) {
    const title = unfinishedTitle(entry, t);
    setFailed(null);
    try {
      await invoke("plans.deleteUnfinished", { planId, id: entry.id });
    } catch (error) {
      // Already gone (a review that expired while its row was on screen) counts as deleted, and the row goes with it.
      if (!isMissingActivity(error)) {
        setFailed(entry);
        // The row may be stale: read the list again.
        void client.invalidateQueries({ queryKey: ["unfinished", planId] });
        return;
      }
    }
    focusAt.current = entries.findIndex((item) => item.id === entry.id);
    setSaid(t("examPage.unfinished.deleted", { title }));
    // The row folds away in place, then the list is read again; under reduced motion at once.
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    setLeaving(entry.id);
    await new Promise((done) => setTimeout(done, reduced ? 0 : 380));
    await client.invalidateQueries({ queryKey: ["unfinished", planId] });
    // A deleted quiz may also leave the path, a simulation the exam's simulation page.
    void client.invalidateQueries({ queryKey: ["plan", planId] });
    setLeaving(null);
  }
  function confirmDelete(entry: UnfinishedEntry) {
    void confirm({
      title: t("examPage.unfinished.deleteTitle", {
        title: unfinishedTitle(entry, t),
      }),
      body: deleteBody(entry, t),
      confirm: t("examPage.unfinished.deleteConfirm"),
      tone: "danger",
    }).then((answer) => {
      // The row folds away and the focus moves on after the dialog has closed, so the page is not inert for it.
      if (answer === "confirm") void remove(entry);
    });
  }
  const menuOf = (entry: UnfinishedEntry): MenuProps => ({
    items: [
      { key: "resume", label: t("examPage.unfinished.resume") },
      { type: "divider" },
      { key: "delete", label: t("examPage.unfinished.delete"), danger: true },
    ],
    onClick: ({ key }) => {
      if (key === "resume") navigate(resumePath(planId, entry));
      if (key === "delete") confirmDelete(entry);
    },
  });
  const row = (entry: UnfinishedEntry) => {
    const title = unfinishedTitle(entry, t);
    return (
      <MenuItemArea
        key={entry.id}
        menu={menuOf(entry)}
        region={t("examPage.unfinished.actions", { title })}
        className={
          leaving === entry.id ? "px-unf-item is-leaving" : "px-unf-item"
        }
      >
        <div className="px-unf-row">
          <button
            type="button"
            className="px-unf-open"
            onClick={() => navigate(resumePath(planId, entry))}
          >
            <span className="px-unf-icon" aria-hidden>
              {entry.state === "writing" ? (
                <Logo working decorative size={16} />
              ) : (
                <Icon name={unfinishedIcons[entry.kind]} size={16} />
              )}
            </span>
            <span className="px-unf-name">
              <b>
                <span className="visually-hidden">
                  {t("examPage.unfinished.resume")}:{" "}
                </span>
                {title}
              </b>
              <small>{unfinishedDetail(entry, now, i18n.language, t)}</small>
            </span>
          </button>
          <MenuButton
            size="sm"
            className="px-unf-dots"
            menu={menuOf(entry)}
            label={t("examPage.unfinished.actions", { title })}
          />
        </div>
      </MenuItemArea>
    );
  };

  return (
    <>
      <section
        className="px-exam-asec px-unf"
        ref={root}
        aria-labelledby={`px-unf-${planId}`}
      >
        <h2 id={`px-unf-${planId}`}>
          {t("examPage.unfinished.title")}
          {unreadable ? null : (
            <span>
              {t("examPage.unfinished.count", { count: entries.length })}
            </span>
          )}
        </h2>
        {unreadable ? (
          <Notice
            tone="danger"
            action={{
              label: t("components.notice.retry"),
              onClick: () => void list.refetch(),
            }}
          >
            {t("examPage.unfinished.loadFailed")}
          </Notice>
        ) : null}
        {failed ? (
          <Notice
            tone="danger"
            action={{
              label: t("components.notice.retry"),
              onClick: () => void remove(failed),
            }}
          >
            {t("examPage.unfinished.deleteFailed", {
              title: unfinishedTitle(failed, t),
            })}
          </Notice>
        ) : null}
        <ul className="px-unf-list">{entries.slice(0, SHOWN).map(row)}</ul>
        {entries.length > SHOWN && all ? (
          <Reveal>
            <ul className="px-unf-list">{entries.slice(SHOWN).map(row)}</ul>
          </Reveal>
        ) : null}
        {entries.length > SHOWN ? (
          <button
            type="button"
            className="px-exam-alink px-unf-more"
            aria-expanded={all}
            onClick={() => setAll(!all)}
          >
            {all
              ? t("examPage.unfinished.showFewer")
              : t("examPage.unfinished.showAll", { count: entries.length })}
            <span className="px-chevron" aria-hidden />
          </button>
        ) : null}
      </section>
      {status}
    </>
  );
}
