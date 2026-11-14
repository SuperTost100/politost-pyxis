import { ConfigProvider } from "antd";
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { grow } from "../lib/grow";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { menuTakesEscape } from "./ItemMenu";
import { Logo } from "./Logo";
import { closingFocus, openingFocus, outsideClickCloses, wrapTab, type FocusRole } from "./dialogFocus";
import "./Dialog.css";

export type DialogWidth = "sm" | "md" | "lg";

export type DialogAction = {
  label: string;
  onClick: () => unknown;
  /** `danger` for an action that destroys something: the only solid red button. `secondary` for an extra action. */
  tone?: "primary" | "danger" | "secondary";
  /** `start` puts it on the left, away from Annulla and the confirming button, as "Archivia invece". */
  side?: "start";
  disabled?: boolean;
  /** The work it started is running: the button shows the working mark and stays where it is. */
  working?: boolean;
};

/**
 * Where an Escape belongs to something opened inside the dialog rather than to the dialog: an item menu, a dropdown, a
 * select's list, or a button or field whose list is open. That one closes first.
 */
const OPENED_INSIDE = ".px-item-menu, .ant-dropdown, .ant-select-dropdown, .ant-picker-dropdown";
const ESCAPE_NOT_MINE = `${OPENED_INSIDE}, [aria-haspopup][aria-expanded="true"], [role=combobox][aria-expanded="true"]`;
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
const FIELDS = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"]';
const TEXT_FIELDS = 'input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="number"], textarea, [contenteditable="true"]';

function focusables(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (node) => !node.closest(OPENED_INSIDE) && node.checkVisibility(),
  );
}

function typedText(dialog: HTMLElement): string[] {
  return [...dialog.querySelectorAll<HTMLElement>(TEXT_FIELDS)].map((node) =>
    node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.value : (node.textContent ?? ""),
  );
}

/**
 * The one dialog of the app (docs/design-system/controls.md, "Dialogs"): a native modal `<dialog>`, so it sits in the top
 * layer above the source panel, popovers and menus, and the page behind it is inert. A serif title, no icon; the buttons
 * at the bottom right with Annulla as the quiet one and the confirming one named by its action; an X at the top right
 * only when there is no Annulla (`cancel={false}`).
 *
 * It grows out of `origin` (or what had the focus as it opened) and shrinks back into it. As it opens the focus goes to
 * `initialFocus`, else its first field, else Annulla, never to a destructive button; Tab stays inside; as it closes the
 * focus goes back to `returnFocus`, `origin` or what had it before. Escape, Annulla, the X and a click outside all call
 * `onClose`; none of them does while `busy`, and a click outside does nothing while a text field holds typed text. A menu
 * or list opened inside it closes on Escape first. The body scrolls and the title and buttons stay in view.
 */
export function Dialog({
  open,
  title,
  description,
  children,
  actions = [],
  cancel,
  onClose,
  width = "sm",
  busy = false,
  origin,
  initialFocus,
  returnFocus,
  onClosed,
  className,
}: {
  open: boolean;
  title: ReactNode;
  /** The sentence under the title, read with it as the dialog's description. */
  description?: ReactNode;
  children?: ReactNode;
  /** In reading order. The extra ones (`side: "start"`) go on the left, the others after Annulla. */
  actions?: DialogAction[];
  /** Annulla's label (Annulla when left out), or false for a dialog that only informs, which gets the X instead. */
  cancel?: string | false;
  onClose: () => void;
  /** 460px for a confirmation, 560 for a form, 720 for a preview. */
  width?: DialogWidth;
  busy?: boolean;
  origin?: RefObject<HTMLElement | null>;
  initialFocus?: RefObject<HTMLElement | null>;
  returnFocus?: RefObject<HTMLElement | null>;
  /** Called once it has shrunk away and given the focus back. */
  onClosed?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const node = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  // Kept on the page while it shrinks away.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const grownFrom = useRef<HTMLElement | null>(null);
  const before = useRef<HTMLElement | null>(null);
  const motion = useRef<Animation | null>(null);
  // A body taller than its room scrolls, and takes a Tab stop so the keyboard can scroll it too.
  const body = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  const latest = useRef({ open, onClose, onClosed, busy, initialFocus, returnFocus, origin });
  latest.current = { open, onClose, onClosed, busy, initialFocus, returnFocus, origin };

  useLayoutEffect(() => {
    const dialog = node.current;
    if (!dialog) return;
    if (open) {
      // Asked to open again while it shrinks away: it stops shrinking and stays.
      if (dialog.open) {
        motion.current?.cancel();
        dialog.classList.remove("is-closing");
        return;
      }
      const active = document.activeElement;
      before.current = active instanceof HTMLElement && active !== document.body ? active : null;
      grownFrom.current = latest.current.origin?.current ?? before.current;
      dialog.showModal();
      focusOnOpen(dialog);
      motion.current = grow(dialog, grownFrom.current, "in");
      return;
    }
    if (!dialog.open) return;
    dialog.classList.add("is-closing");
    const into = grownFrom.current?.isConnected ? grownFrom.current : null;
    motion.current = grow(dialog, into, "out", () => {
      const inside = dialog.contains(document.activeElement);
      dialog.close();
      dialog.classList.remove("is-closing");
      const active = document.activeElement;
      const target = closingFocus(
        [latest.current.returnFocus?.current, latest.current.origin?.current, before.current],
        (element) => element.isConnected,
        inside || !active || active === document.body || active === before.current,
      );
      target?.focus({ preventScroll: true });
      setMounted(false);
      latest.current.onClosed?.();
    });
  }, [open, mounted]);

  useLayoutEffect(() => {
    const box = body.current;
    if (!box) return;
    const measure = () => setScrolls(box.scrollHeight > box.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    for (const child of box.children) observer.observe(child);
    return () => observer.disconnect();
  }, [mounted, children, description]);

  // Taken off the page while open (its page went away): the top layer lets it go at once.
  useLayoutEffect(() => {
    const dialog = node.current;
    return () => dialog?.close();
  }, [mounted]);

  function focusOnOpen(dialog: HTMLDialogElement) {
    const candidates: Array<{ node: HTMLElement; role: FocusRole }> = [];
    const body = dialog.querySelector(".px-dialog-body");
    for (const field of body?.querySelectorAll<HTMLElement>(FIELDS) ?? [])
      if (!field.closest(OPENED_INSIDE) && field.checkVisibility()) candidates.push({ node: field, role: "field" });
    for (const button of dialog.querySelectorAll<HTMLElement>("[data-dialog-role] button:not([disabled])"))
      candidates.push({ node: button, role: button.closest<HTMLElement>("[data-dialog-role]")!.dataset.dialogRole as FocusRole });
    const target = openingFocus(latest.current.initialFocus?.current ?? null, candidates) ?? dialog;
    target.focus({ preventScroll: true });
  }

  if (!mounted) return null;
  const start = actions.filter((action) => action.side === "start");
  const end = actions.filter((action) => action.side !== "start");
  // Shrinking away, it is already answered: its buttons stay disabled and nothing closes it again.
  const answered = !open;
  const close = () => {
    if (!latest.current.busy && latest.current.open) latest.current.onClose();
  };
  const button = (action: DialogAction) => (
    <span
      key={action.label}
      className="px-dialog-button"
      data-dialog-role={action.tone === "danger" ? "danger" : "action"}
    >
      <Button
        variant={action.tone === "danger" ? "danger-solid" : (action.tone ?? "primary")}
        disabled={busy || answered || action.disabled}
        onClick={() => void action.onClick()}
      >
        {action.working ? <Logo size={16} working decorative /> : null}
        {action.label}
      </Button>
    </span>
  );

  return createPortal(
    <dialog
      ref={node}
      // The role is written out: pages check for an open dialog by it (`menu-state.ts`, the study pages' keys).
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy || undefined}
      tabIndex={-1}
      className={["px-dialog", `is-${width}`, className].filter(Boolean).join(" ")}
      onKeyDownCapture={(event) => {
        // A select's list stops the Escape it closes on, so it never reaches `onKeyDown`, and the browser would close
        // the dialog with it. Decided here, while the list still reads as open.
        if (event.key === "Escape" && event.target instanceof Element && event.target.closest(ESCAPE_NOT_MINE))
          event.preventDefault();
      }}
      onKeyDown={(event) => {
        const dialog = node.current;
        if (!dialog) return;
        if (event.key === "Escape") {
          if (event.defaultPrevented) return;
          // Always: Chromium closes a modal dialog by itself on a second Escape, which would skip `busy` and the page's
          // own question before losing work.
          event.preventDefault();
          if (
            menuTakesEscape(event.nativeEvent) ||
            (event.target instanceof Element && event.target.closest(ESCAPE_NOT_MINE))
          )
            return;
          event.stopPropagation();
          close();
          return;
        }
        if (event.key !== "Tab" || (event.target instanceof Element && event.target.closest(OPENED_INSIDE))) return;
        const stops = focusables(dialog);
        const next = wrapTab(stops.length, stops.indexOf(document.activeElement as HTMLElement), event.shiftKey);
        if (next === null) return;
        event.preventDefault();
        stops[next]!.focus();
      }}
      onCancel={(event) => {
        // Any other request to close, such as the system's back gesture, goes the same way as Escape.
        event.preventDefault();
        close();
      }}
      onMouseDown={(event) => {
        const dialog = node.current;
        if (!dialog || event.target !== dialog) return;
        // A click outside leaves the focus where it is, so a dialog that stays keeps it in its field.
        event.preventDefault();
        if (outsideClickCloses(typedText(dialog), latest.current.busy)) close();
      }}
    >
      {/* Menus and lists opened inside are drawn inside, so they sit above it and are not inert behind it. */}
      <ConfigProvider getPopupContainer={() => node.current ?? document.body}>
        <div className="px-dialog-card">
          <div className="px-dialog-head">
            <h2 id={titleId} className="px-dialog-title title-2">
              {title}
            </h2>
            {cancel === false ? (
              <span className="px-dialog-close" data-dialog-role="close">
                <IconButton icon="x" label={t("dialog.close")} variant="ghost" size="sm" onClick={close} />
              </span>
            ) : null}
          </div>
          <div ref={body} className="px-dialog-body" tabIndex={scrolls ? 0 : undefined}>
            {description ? (
              <div id={descriptionId} className="px-dialog-description body">
                {description}
              </div>
            ) : null}
            {children}
          </div>
          {actions.length || cancel !== false ? (
            <div className="px-dialog-foot">
              {start.length ? <div className="px-dialog-start">{start.map(button)}</div> : null}
              {cancel !== false ? (
                <span className="px-dialog-button" data-dialog-role="cancel">
                  <Button variant="ghost" disabled={busy || answered} onClick={close}>
                    {cancel ?? t("dialog.cancel")}
                  </Button>
                </span>
              ) : null}
              {end.map(button)}
            </div>
          ) : null}
        </div>
      </ConfigProvider>
    </dialog>,
    document.body,
  );
}

export type ConfirmAnswer = "confirm" | "extra" | "cancel";

export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  /** The confirming button, named by its action: "Elimina l'esame", "Esci senza salvare". */
  confirm: string;
  /** `danger` when confirming destroys something. */
  tone?: "primary" | "danger";
  /** Annulla's label, or false for a dialog that only informs (its X answers "cancel"). */
  cancel?: string | false;
  /** An extra action on the left, as "Archivia invece"; it answers "extra". */
  extra?: string;
  width?: DialogWidth;
  /** Work the confirming button starts: the dialog stays, busy, until it ends, then answers "confirm". */
  run?: () => Promise<unknown>;
  /** What the dialog grows out of; what had the focus by default. */
  origin?: HTMLElement | null;
  /** Where the focus goes when it closes, when not back to what had it before. */
  returnFocus?: HTMLElement | null;
  /**
   * Called once it has shrunk away and given the focus back. For work that ran inside it (`run`) and left its opener
   * gone: the page behind is inert while the dialog is open, so the focus can only be placed after it has closed.
   */
  onClosed?: () => void;
  /** Takes the question back while it is open: it closes and answers "cancel". */
  signal?: AbortSignal;
};

type Ask = {
  id: number;
  options: ConfirmOptions;
  open: boolean;
  busy: boolean;
  resolve: (answer: ConfirmAnswer) => void;
  reject: (error: unknown) => void;
};

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<ConfirmAnswer>) | null>(null);

/**
 * Asks a question in the one dialog and answers with the button chosen. Escape, the X, Annulla and a click outside
 * answer "cancel". One question at a time: asked while another is open, it answers "cancel" at once and nothing opens.
 *
 *     if ((await confirm({ title, body, confirm: t("map.deleteConfirm"), tone: "danger" })) !== "confirm") return;
 */
export function useConfirm(): (options: ConfirmOptions) => Promise<ConfirmAnswer> {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm needs a ConfirmProvider above it");
  return confirm;
}

/** Draws the questions `useConfirm` asks. Once, around the whole app (`App.tsx`). */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [asks, setAsks] = useState<Ask[]>([]);
  const showing = useRef<Ask | null>(null);
  // The question whose work is running: only the end of that work answers it, and its button does nothing meanwhile.
  const running = useRef<number | null>(null);
  const counter = useRef(0);

  // Answers the question `id` if it is still the one showing. A click that comes later, while it shrinks away or after
  // another answer, does nothing.
  const settle = useCallback((id: number, answer: ConfirmAnswer | { error: unknown }, byItsWork = false) => {
    const ask = showing.current;
    if (!ask || ask.id !== id || (running.current === id && !byItsWork)) return;
    showing.current = null;
    setAsks((list) => list.map((item) => (item.id === id ? { ...item, open: false, busy: false } : item)));
    if (typeof answer === "string") ask.resolve(answer);
    else ask.reject(answer.error);
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions) => {
      if (showing.current || options.signal?.aborted) return Promise.resolve<ConfirmAnswer>("cancel");
      return new Promise<ConfirmAnswer>((resolve, reject) => {
        const ask: Ask = { id: ++counter.current, options, open: true, busy: false, resolve, reject };
        showing.current = ask;
        setAsks((list) => [...list, ask]);
        options.signal?.addEventListener("abort", () => settle(ask.id, "cancel"), { once: true });
      });
    },
    [settle],
  );

  async function confirmed(id: number) {
    // Checked before the work starts: a second quick click, or one after Annulla, starts nothing.
    const ask = showing.current;
    if (!ask || ask.id !== id || running.current === id) return;
    const run = ask.options.run;
    if (!run) return settle(id, "confirm");
    running.current = id;
    setAsks((list) => list.map((item) => (item.id === id ? { ...item, busy: true } : item)));
    try {
      await run();
      settle(id, "confirm", true);
    } catch (error) {
      settle(id, { error }, true);
    } finally {
      if (running.current === id) running.current = null;
    }
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {asks.map((ask) => {
        const { options } = ask;
        const actions: DialogAction[] = [
          ...(options.extra
            ? [{ label: options.extra, tone: "secondary" as const, side: "start" as const, onClick: () => settle(ask.id, "extra") }]
            : []),
          {
            label: options.confirm,
            tone: options.tone ?? "primary",
            working: ask.busy,
            onClick: () => void confirmed(ask.id),
          },
        ];
        return (
          <Dialog
            key={ask.id}
            open={ask.open}
            title={options.title}
            description={options.body}
            cancel={options.cancel}
            actions={actions}
            width={options.width}
            busy={ask.busy}
            origin={{ current: options.origin ?? null }}
            returnFocus={{ current: options.returnFocus ?? null }}
            onClose={() => settle(ask.id, "cancel")}
            onClosed={() => {
              setAsks((list) => list.filter((item) => item.id !== ask.id));
              options.onClosed?.();
            }}
          />
        );
      })}
    </ConfirmContext.Provider>
  );
}
