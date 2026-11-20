import { formatBytes } from "@shared/format-bytes";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../components/Icon";
import { ImageViewer } from "../../components/ImageViewer";
import { openSourceViewer } from "../../components/SourceViewer";
import { imageFileName } from "../../lib/imageName";

/**
 * The files a sent message carried, as the chat reads them or as the composer held them before the reply arrived. `sha`
 * is the stored picture of a photo and `src` the picture staged for it, either of which draws its thumbnail.
 */
export type SentFile = {
  id: string;
  name: string | null;
  kind: "document" | "photo";
  sourceId?: string | null;
  size?: number | null;
  sha?: string | null;
  src?: string;
};

/** Where a stored photo is read from. */
const storedPhoto = (sha: string) => `pyxis-blob://${sha}`;

/**
 * The picture a photo's thumbnail shows: the one staged for it, or its stored copy. A photo sent before names were kept
 * (it has none) has no thumbnail of its own, and shows as a chip.
 */
const thumbnailSource = (file: SentFile) =>
  file.kind === "photo" ? (file.src ?? (file.sha && file.name ? storedPhoto(file.sha) : undefined)) : undefined;

function Thumbnail({ file, src, onBroken }: { file: SentFile; src: string; onBroken: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const name = file.name ?? t("ask.attach.photo");
  return (
    <>
      <button
        ref={button}
        type="button"
        className="ask-sent-thumb"
        aria-label={t("ask.attach.openPhoto", { name })}
        onClick={() => setOpen(true)}
      >
        <img src={src} alt="" onError={onBroken} />
      </button>
      {open ? (
        <ImageViewer
          src={src}
          label={t("ask.attach.photoViewer")}
          caption={t("ask.attach.photoCaption", { name })}
          filename={imageFileName(name.replace(/\.[a-z0-9]{1,5}$/i, ""), t("ask.attach.photo"))}
          ground="photo"
          origin={button.current}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** A photo is a thumbnail that opens in the viewer, and a document is a chip that opens its file. A photo with no stored picture is a chip too. */
export function SentFiles({ files }: { files: readonly SentFile[] }) {
  const { t, i18n } = useTranslation();
  // A stored picture that cannot be read (its copy was freed) shows its file as a chip.
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  if (files.length === 0) return null;
  return (
    <ul className="ask-sent-files" aria-label={t("ask.attach.sent")}>
      {files.map((file) => {
        const src = broken.has(file.id) ? undefined : thumbnailSource(file);
        if (src)
          return (
            <li key={file.id}>
              <Thumbnail file={file} src={src} onBroken={() => setBroken((now) => new Set(now).add(file.id))} />
            </li>
          );
        const name = file.name ?? t("ask.attach.photo");
        const size = file.size ? formatBytes(file.size, i18n.language) : "";
        const body = (
          <>
            <Icon name={file.kind === "photo" ? "image" : "file-text"} size={18} />
            <b>{name}</b>
            {size ? <small>{size}</small> : null}
          </>
        );
        return (
          <li key={file.id}>
            {file.sourceId ? (
              <button type="button" className="ask-sent-doc" onClick={() => openSourceViewer({ sourceId: file.sourceId! })}>
                {body}
              </button>
            ) : (
              <span className="ask-sent-doc is-plain">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
