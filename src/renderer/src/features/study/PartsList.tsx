import { ArrowRight, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { RequestOutput } from "@shared/ipc";
import { InlineMarkdown } from "../../components/InlineMarkdown";
import { Logo } from "../../components/Logo";
import { partMark, partStateWord, type PartMark } from "./partPage";

type Outline = NonNullable<Extract<RequestOutput<"study.part">, { mode: "parts" }>["outline"]>;

/**
 * A topic's parts as a list of links (`nav`), in the parts column beside the sheet and in the popover that replaces it
 * in a narrow window: a tick on the parts read, an arrow on the open one, a dashed circle on a part not written yet and
 * the working mark on one being written, with the minutes of every part not read. Each link's name says its state.
 * Titles are Markdown, so a formula in one is drawn, and named from KaTeX's MathML. `onPick` runs when a link is followed, as the popover closes.
 */
export function PartsList({
  outline,
  current,
  href,
  onPick,
  heading = true,
}: {
  outline: Outline;
  current: number;
  href: (position: number) => string;
  onPick?: () => void;
  /** The list's visible heading, which the popover leaves to its own name. */
  heading?: boolean;
}) {
  const { t } = useTranslation();
  const unwritten = outline.parts.some((part) => part.state !== "written");
  return (
    <nav className="px-parts" aria-label={t("lesson.partsTitle")}>
      {heading ? (
        <p className="px-parts-label" aria-hidden>
          {t("lesson.partsTitle")}
        </p>
      ) : null}
      <ol>
        {outline.parts.map((part) => {
          const mark = partMark(part, current);
          const title = part.kind === "recap" ? t("lesson.recapTitle") : part.title;
          const word = partStateWord(part);
          const state =
            word === "writing"
              ? t("lesson.partWriting")
              : word === "read"
                ? t("lesson.partRead")
                : word === "unwritten"
                  ? t("lesson.partUnwritten")
                  : null;
          const minutes = !part.done && mark !== "writing" ? t("lesson.minutesShort", { count: part.minutes }) : null;
          return (
            <li key={part.id} data-done={part.done ? "" : undefined}>
              <Link
                to={href(part.position)}
                className={`px-parts-link is-${mark}`}
                aria-current={part.position === current ? "page" : undefined}
                onClick={onPick}
              >
                <MarkIcon mark={mark} />
                <span className="px-parts-title">
                  <InlineMarkdown>{title}</InlineMarkdown>
                </span>
                {minutes ? <span className="px-parts-minutes">{minutes}</span> : null}
                {state ? <span className="visually-hidden">, {state}</span> : null}
              </Link>
            </li>
          );
        })}
      </ol>
      {unwritten ? <p className="px-parts-note">{t("lesson.partsNote")}</p> : null}
    </nav>
  );
}

function MarkIcon({ mark }: { mark: PartMark }) {
  if (mark === "current") return <ArrowRight size={14} strokeWidth={2} aria-hidden className="px-parts-mark" />;
  if (mark === "done") return <Check size={14} strokeWidth={2} aria-hidden className="px-parts-mark" />;
  if (mark === "writing")
    return (
      <span className="px-parts-mark">
        <Logo size={16} working decorative />
      </span>
    );
  return <span className={`px-parts-mark px-parts-circle${mark === "unwritten" ? " is-dashed" : ""}`} aria-hidden />;
}
