import { useTranslation } from "react-i18next";
import { Icon } from "../../components/Icon";
import { Logo } from "../../components/Logo";
import "./AttachmentChip.css";

/**
 * A file attached to the message being written, with its own state: the working mark while it is read, a bar along the
 * lower edge as far as the reading has come, the size once it is ready, and the reason, tinted, when it failed. The remove
 * control stays in every state.
 */
export function AttachmentChip({
  name,
  line,
  state,
  progress,
  thumbnail,
  photo = false,
  removeLabel,
  onRemove,
}: {
  name: string;
  /** The words under the name: what the reading is doing, the size, or why it failed. */
  line: string;
  state: "reading" | "ready" | "failed";
  /** How far the reading is, from 0 to 1, when known. The bar shows with reading only. */
  progress?: number;
  /** A staged photo's picture, in the place of the file icon. */
  thumbnail?: { src: string; alt: string };
  /** The file is a photo, which has the picture icon when no picture is staged for it. */
  photo?: boolean;
  removeLabel: string;
  onRemove: () => void;
}) {
  useTranslation();
  const bar = state === "reading" && progress !== undefined && progress > 0 ? Math.min(1, progress) : null;
  return (
    <div className={`px-att is-${state}`}>
      <span className="px-att-icon" aria-hidden={thumbnail ? undefined : true}>
        {thumbnail ? (
          <img src={thumbnail.src} alt={thumbnail.alt} />
        ) : state === "reading" ? (
          <Logo size={20} working decorative />
        ) : state === "failed" ? (
          <Icon name="triangle-alert" size={20} />
        ) : (
          <Icon name={photo ? "image" : "file-text"} size={20} />
        )}
      </span>
      <span className="px-att-text">
        <b title={name}>{name}</b>
        {line ? <small>{line}</small> : null}
      </span>
      <button type="button" className="px-att-remove" aria-label={removeLabel} title={removeLabel} onClick={onRemove}>
        <Icon name="x" size={16} />
      </button>
      {bar !== null ? (
        <span className="px-att-bar" aria-hidden>
          <i style={{ width: `${Math.round(bar * 100)}%` }} />
        </span>
      ) : null}
    </div>
  );
}
