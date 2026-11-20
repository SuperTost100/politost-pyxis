import type { MenuProps } from "antd";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { copyImage, saveImage } from "../lib/imageActions";
import { imageFileName } from "../lib/imageName";
import { Icon } from "./Icon";
import { ImageViewer } from "./ImageViewer";
import { InlineMarkdown } from "./InlineMarkdown";
import { MenuButton, useItemMenu } from "./ItemMenu";
import "./Figure.css";
import { Working } from "./Working";

export type FigureAction = "zoom" | "download" | "copy";

/**
 * The menu of a figure, which the three dots, a right-click and Shift+F10 all open: the actions only, in this order.
 * `act` hears the pick.
 */
export function figureMenu(
  labels: Record<FigureAction, string>,
  act: (action: FigureAction) => void,
): MenuProps {
  return {
    items: [
      { key: "zoom", icon: <Icon name="maximize-2" size={16} />, label: labels.zoom },
      { key: "download", icon: <Icon name="download" size={16} />, label: labels.download },
      { key: "copy", icon: <Icon name="copy" size={16} />, label: labels.copy },
    ],
    onClick: ({ key }) => act(key as FigureAction),
  };
}

/**
 * A figure the tutor drew in the Python sandbox, with its caption. Without an image it is still being drawn
 * (`drawing`) or it failed, and then nothing shows. A figure drawn for the dark theme (`darkImage`) shows that picture
 * there, and every other figure keeps its white card in both themes.
 */
export function Figure({
  caption,
  image,
  darkImage,
  drawing = false,
}: {
  caption: string;
  image?: string;
  darkImage?: string;
  drawing?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<"copied" | "saved" | "failed" | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => setSaid(null), 1800);
    return () => clearTimeout(timer);
  }, [said]);
  // The picture the student sees now is the one they open, keep and copy.
  const shown = () =>
    darkImage && document.documentElement.dataset.theme === "dark" ? darkImage : image;
  async function act(action: FigureAction) {
    const src = shown();
    if (!src) return;
    if (action === "zoom") return setOpen(true);
    try {
      if (action === "download") {
        if (await saveImage(src, imageFileName(caption, t("components.figure.fileName")))) setSaid("saved");
      } else {
        await copyImage(src);
        setSaid("copied");
      }
    } catch {
      setSaid("failed");
    }
  }
  const menu = figureMenu(
    {
      zoom: t("components.figure.zoom"),
      download: t("components.figure.download"),
      copy: t("components.figure.copy"),
    },
    (action) => void act(action),
  );
  const { bind, popup } = useItemMenu({ menu, region: t("components.figure.menu"), returnTo: () => opener.current });
  if (!image)
    return drawing ? (
      <div className="px-figure is-drawing">
        <Working slot className="px-figure-working" line={t("smart.drawing")} />
      </div>
    ) : null;
  return (
    <figure className="px-figure" {...bind}>
      <div className="px-figure-frame">
        <button
          ref={opener}
          type="button"
          className="px-figure-open"
          aria-label={t("components.figure.open", { caption })}
          onClick={() => setOpen(true)}
        >
          <img className="px-figure-light" src={image} alt={caption} />
          {darkImage ? <img className="px-figure-dark" src={darkImage} alt={caption} /> : null}
        </button>
        <MenuButton
          menu={menu}
          label={t("components.figure.menu")}
          size="sm"
          className="px-figure-dots"
        />
        {said ? (
          <span className="px-figure-said" role="status">
            {t(`components.figure.${said}`)}
          </span>
        ) : null}
      </div>
      {/* The image's alt already reads the caption, so screen readers skip the visible copy. */}
      <figcaption className="small" aria-hidden>
        <InlineMarkdown>{caption}</InlineMarkdown>
      </figcaption>
      {popup}
      {open ? (
        <ImageViewer
          src={shown() ?? image}
          label={t("components.figure.viewer")}
          caption={caption}
          filename={imageFileName(caption, t("components.figure.fileName"))}
          ground={darkImage && document.documentElement.dataset.theme === "dark" ? "dark" : "white"}
          origin={opener.current}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </figure>
  );
}
