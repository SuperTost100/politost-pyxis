import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useBlocker, useLocation } from "react-router";
import { useConfirm } from "../components/Dialog";
import { stayingFocus } from "../components/dialogFocus";

/**
 * Asks "Uscire senza salvare?" before the student leaves a page that holds work it does not save by itself. It stands on
 * the router's own blocking, so it holds whatever moves to another page: a back control, the sidebar, a link, the menu's
 * Indietro and its keys. A move inside the page (the same path, another query) never asks. "Resta qui", Escape or a
 * click outside keep the page as it was and give the focus back to where it was; "Esci senza salvare" runs `onLeave` and
 * goes where the student was going.
 *
 * `dirty` is read when a move starts; a function suits work kept in a ref. Call `release()` before a move that follows a
 * save or a delete, so that move goes without asking. One page at a time holds the guard: the router keeps one blocker.
 * A dialog that holds typed work asks through `useConfirm` instead, since closing it is not a move.
 */
export function useLeaveGuard({
  dirty,
  body,
  onLeave,
}: {
  dirty: boolean | (() => boolean);
  /** What would be lost, in a sentence. */
  body: string;
  onLeave?: () => void;
}): { release: () => void } {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const latest = useRef({ dirty, body, onLeave });
  latest.current = { dirty, body, onLeave };
  const released = useRef(false);
  // A page the router keeps on screen at a new address (the student came straight back to it) guards again.
  const { key } = useLocation();
  useEffect(() => {
    released.current = false;
  }, [key]);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (released.current || currentLocation.pathname === nextLocation.pathname) return false;
    const held = latest.current.dirty;
    return typeof held === "function" ? held() : held;
  });
  const current = useRef(blocker);
  current.current = blocker;

  // What had the focus before the one that has it now: a click on a link takes the focus before the page asks.
  const focus = useRef<{ now: HTMLElement | null; before: HTMLElement | null }>({ now: null, before: null });
  useEffect(() => {
    const note = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target === focus.current.now) return;
      focus.current = { now: event.target, before: focus.current.now };
    };
    document.addEventListener("focusin", note, true);
    return () => document.removeEventListener("focusin", note, true);
  }, []);

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    const clickedLink =
      document.documentElement.dataset.focusSource === "pointer" && Boolean(active?.matches("a[href]"));
    const before = focus.current.before?.isConnected ? focus.current.before : null;
    void confirm({
      title: t("leave.title"),
      body: latest.current.body,
      cancel: t("leave.stay"),
      confirm: t("leave.go"),
      tone: "danger",
      origin: active,
      returnFocus: stayingFocus(active, before, clickedLink),
    }).then((answer) => {
      const now = current.current;
      if (now.state !== "blocked") return;
      if (answer !== "confirm") return now.reset();
      released.current = true;
      latest.current.onLeave?.();
      now.proceed();
    });
  }, [blocker.state]);

  return { release: useCallback(() => void (released.current = true), []) };
}
