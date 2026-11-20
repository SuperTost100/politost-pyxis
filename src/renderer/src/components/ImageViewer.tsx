import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { plainReading } from "../features/ask/outline";
import { grow } from "../lib/grow";
import { saveImage } from "../lib/imageActions";
import { ZOOM_START, ZOOM_STEPS, zoomFrom } from "../lib/viewerZoom";
import { Icon } from "./Icon";
import { InlineMarkdown } from "./InlineMarkdown";
import "./ImageViewer.css";

/**
 * A picture of a message at the size of the window, with zoom steps, download and close. It grows out of `origin`, the
 * figure or thumbnail that was opened, and shrinks back into it, and Escape closes it and gives the focus back there.
 * `ground` is what the picture lies on: a white card for a figure drawn on white, the picture's own dark ground for one
 * drawn for the dark theme, and nothing for a photo, which fills its frame.
 */
export function ImageViewer({
  src,
  label,
  caption,
  filename,
  ground = "white",
  origin,
  onClose,
}: {
  src: string;
  /** What the dialog is called for screen readers: "Figure enlarged". */
  label: string;
  caption?: string;
  /** The PNG file the download offers. */
  filename: string;
  ground?: "white" | "dark" | "photo";
  origin: HTMLElement | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [percent, setPercent] = useState<number>(ZOOM_START);
  // The picture's proportions, once it has loaded, so the card is sized to fit the window in both directions.
  const [ratio, setRatio] = useState(1.6);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const closing = useRef(false);

  useEffect(() => {
    closeButton.current?.focus();
    if (card.current) grow(card.current, origin, "in");
    // The picture grows from where it was, so the scrim fades in with it rather than cutting in.
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      root.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
  }, [origin]);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);

  function close() {
    if (closing.current) return;
    closing.current = true;
    const done = () => {
      onClose();
      if (origin?.isConnected) origin.focus({ preventScroll: true });
    };
    if (card.current && origin?.isConnected) {
      root.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "ease-out", fill: "forwards" });
      grow(card.current, origin, "out", done).addEventListener("cancel", done);
    } else done();
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "+" || event.key === "=") setPercent((now) => zoomFrom(now, 1));
    else if (event.key === "-") setPercent((now) => zoomFrom(now, -1));
    else if (event.key === "0") setPercent(ZOOM_START);
    else if (event.key === "Tab") {
      // The viewer holds the focus: Tab goes round its own buttons.
      // The stage is part of the cycle: a zoomed picture is read by scrolling it, with the arrow keys, once it has the focus.
      const stops = Array.from(root.current?.querySelectorAll<HTMLElement>("button, .px-viewer-stage") ?? []);
      const first = stops[0];
      const last = stops.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  async function download() {
    setFailed(false);
    try {
      if (await saveImage(src, filename)) setSaved(true);
    } catch {
      setFailed(true);
    }
  }

  return createPortal(
    <div
      ref={root}
      className="px-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        // A click on the scrim, not on the picture or the tools, closes it.
        if (event.target === event.currentTarget || (event.target as Element).classList.contains("px-viewer-stage")) close();
      }}
    >
      <div className="px-viewer-tools">
        <button
          type="button"
          className="px-viewer-btn"
          aria-label={t("components.viewer.zoomOut")}
          title={t("components.viewer.zoomOut")}
          // aria-disabled, not disabled: a button that is disabled while it has the focus loses it, and Escape and the keys stop working.
          aria-disabled={percent <= ZOOM_STEPS[0]}
          onClick={() => setPercent((now) => zoomFrom(now, -1))}
        >
          <Icon name="zoom-out" size={18} />
        </button>
        <span className="px-viewer-percent" role="status" aria-label={t("components.viewer.zoom", { percent })}>
          {percent}%
        </span>
        <button
          type="button"
          className="px-viewer-btn"
          aria-label={t("components.viewer.zoomIn")}
          title={t("components.viewer.zoomIn")}
          aria-disabled={percent >= ZOOM_STEPS.at(-1)!}
          onClick={() => setPercent((now) => zoomFrom(now, 1))}
        >
          <Icon name="zoom-in" size={18} />
        </button>
        <span className="px-viewer-sep" aria-hidden />
        <button
          type="button"
          className="px-viewer-btn"
          aria-label={t("components.viewer.download")}
          title={t("components.viewer.download")}
          onClick={() => void download()}
        >
          <Icon name={saved ? "check" : "download"} size={18} />
        </button>
        <button
          ref={closeButton}
          type="button"
          className="px-viewer-btn"
          aria-label={t("components.viewer.close")}
          title={t("components.viewer.close")}
          onClick={close}
        >
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="px-viewer-stage" tabIndex={0} role="region" aria-label={t("components.viewer.stage")}>
        <figure className="px-viewer-figure" style={{ "--zoom": percent / 100, "--ratio": ratio } as React.CSSProperties}>
          <div ref={card} className={`px-viewer-card is-${ground}`}>
            <img
              src={src}
              alt={caption ? plainReading(caption) : ""}
              draggable={false}
              onLoad={(event) => {
                const { naturalWidth, naturalHeight } = event.currentTarget;
                if (naturalWidth > 0 && naturalHeight > 0) setRatio(naturalWidth / naturalHeight);
              }}
            />
          </div>
          {caption ? (
            <figcaption>
              <InlineMarkdown>{caption}</InlineMarkdown>
            </figcaption>
          ) : null}
        </figure>
      </div>
      <span className="visually-hidden" role="status">
        {saved ? t("components.viewer.saved") : failed ? t("components.viewer.saveFailed") : ""}
      </span>
    </div>,
    document.body,
  );
}
