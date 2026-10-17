import { useTranslation } from "react-i18next";
import { InlineMarkdown } from "./InlineMarkdown";
import "./Figure.css";

/**
 * A figure the tutor drew in the Python sandbox, with its caption. Without an image it is still being drawn
 * (`drawing`) or it failed, and then nothing shows.
 */
export function Figure({
  caption,
  image,
  drawing = false,
}: {
  caption: string;
  image?: string;
  drawing?: boolean;
}) {
  const { t } = useTranslation();
  if (!image)
    return drawing ? (
      <div className="px-figure is-drawing" role="status">
        <span className="px-figure-skeleton" aria-hidden />
        <span className="small ink-muted">{t("smart.drawing")}</span>
      </div>
    ) : null;
  return (
    <figure className="px-figure">
      <img src={image} alt={caption} />
      {/* The image's alt already reads the caption, so screen readers skip the visible copy. */}
      <figcaption className="small" aria-hidden>
        <InlineMarkdown>{caption}</InlineMarkdown>
      </figcaption>
    </figure>
  );
}
