import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { MathCheck } from "@shared/math-check";
import { passageQuery } from "../lib/passagePlaces";
import { useCheckTally } from "../lib/mathChecks";
import { citedRanges } from "../lib/citedRanges";
import { placeText, rowText, sourceGroups, type CitedPlace, type ListedPlace, type SourceGroup } from "../lib/sourcePlaces";
import { openSourceViewer } from "./SourceViewer";
import "./SourcesRow.css";

/** The name of the CSS highlight that tints the words a pointed-at passage supports (`::highlight(px-cited)`). */
const TINT = "px-cited";
/** A pointer that only crosses the list opens no passage. */
const HOVER_DELAY = 110;

/** The words of a passage as the card quotes them: about three lines, cut at a word. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 280) return flat;
  return `${flat.slice(0, 280).replace(/\s+\S*$/, "")}…`;
}

function tint(host: HTMLElement | null, numbers: readonly number[]) {
  const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
  if (!registry) return;
  if (!host || numbers.length === 0) {
    registry.delete(TINT);
    return;
  }
  registry.set(TINT, new Highlight(...citedRanges(host, new Set(numbers))));
}

type Card = { place: ListedPlace; title: string; anchor: HTMLElement };

/**
 * The row that ends an answer or a lesson part, in place of marks in its text: "3 fonti · 2 risultati verificati". It
 * opens in place into the list of sources, one row per source with its places. A place opens the source there, and
 * pointing at it or focusing it shows the passage and tints the words in the text that rest on it. The one passage of
 * one source needs no list: the row names it and opens it. While the list is open, the checked formulas show their grey
 * check (`[data-checks-shown]` on the host).
 *
 * The row lives inside the element marked `data-cited-host`, which holds the text and its citation marks.
 */
export function SourcesRow({
  places,
  order,
  claims = [],
  variant = "chat",
  arriving = false,
}: {
  /** The passages the page knows, by their [Pn] number. */
  places: readonly CitedPlace[];
  /** The numbers the text cites, in the order it first cites them (`citedOrder`). */
  order: readonly number[];
  /** The math claims of the text, whose checks the row counts. */
  claims?: readonly MathCheck[];
  variant?: "chat" | "lesson" | "body";
  /** The text has just been written: the row grows out of its end. */
  arriving?: boolean;
}) {
  const { t } = useTranslation();
  const groups = useMemo(() => sourceGroups(places, order), [places, order]);
  const tally = useCheckTally(claims);
  const text = rowText(t, groups, tally);
  const box = useRef<HTMLDivElement>(null);
  const fold = useRef<HTMLDivElement>(null);
  const listId = useId();
  const cardId = useId();
  const [open, setOpen] = useState(false);
  // The count of checked results, pressed or pointed at, shows the checks when there is no list to open.
  const [pressed, setPressed] = useState(false);
  const [statHover, setStatHover] = useState(false);
  const [card, setCard] = useState<Card | null>(null);
  const timer = useRef(0);
  const host = useCallback(() => box.current?.closest<HTMLElement>("[data-cited-host]") ?? null, []);

  const shown = open || pressed || statHover;
  useLayoutEffect(() => {
    const element = host();
    element?.toggleAttribute("data-checks-shown", shown);
    return () => element?.removeAttribute("data-checks-shown");
  }, [host, shown]);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setCard(null);
    tint(null, []);
  }, []);
  useEffect(() => hide, [hide]);
  const show = useCallback(
    (place: ListedPlace, title: string, anchor: HTMLElement, wait: boolean) => {
      window.clearTimeout(timer.current);
      const now = () => {
        setCard({ place, title, anchor });
        tint(host(), place.numbers);
      };
      if (wait) timer.current = window.setTimeout(now, HOVER_DELAY);
      else now();
    },
    [host],
  );
  // Escape closes the passage first; the list stays open.
  useEffect(() => {
    if (!card) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      hide();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [card, hide]);

  // Opened, the list comes into view if it opened below the window's edge, once it has grown.
  useEffect(() => {
    if (!open) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timeout = window.setTimeout(
      () => fold.current?.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" }),
      still ? 0 : 240,
    );
    return () => window.clearTimeout(timeout);
  }, [open]);

  if (!text) return null;

  const placeProps = (place: ListedPlace, group: SourceGroup) => ({
    "data-cite-place": place.numbers.join(" "),
    "aria-describedby": card?.place.passageId === place.passageId ? cardId : undefined,
    onClick: () => openSourceViewer({ passageId: place.passageId }),
    onPointerEnter: (event: PointerEvent<HTMLElement>) => show(place, group.title, event.currentTarget, true),
    onPointerLeave: hide,
    onFocus: (event: FocusEvent<HTMLElement>) => show(place, group.title, event.currentTarget, false),
    onBlur: hide,
  });
  const sep = (
    <span className="px-sources-sep" aria-hidden>
      ·
    </span>
  );
  const stat = text.checks ? (
    tally.pending > 0 ? (
      <span className="px-sources-stat">{text.checks}</span>
    ) : (
      <button
        type="button"
        className="px-sources-stat is-toggle"
        aria-pressed={pressed}
        onClick={() => setPressed((now) => !now)}
        onPointerEnter={() => setStatHover(true)}
        onPointerLeave={() => setStatHover(false)}
      >
        {text.single || text.sources ? null : <Check size={14} strokeWidth={2} aria-hidden />}
        {text.checks}
      </button>
    )
  ) : null;

  let bar: ReactNode;
  if (text.single) {
    const group = groups[0]!;
    const place = text.single;
    const where = place.label ? placeText(t, place.label) : null;
    bar = (
      <>
        <button
          type="button"
          className="px-sources-row is-link"
          aria-label={placeName(t, group.title, place)}
          {...placeProps(place, group)}
        >
          <span>
            <b>{group.title}</b>
            {where ? `, ${where}` : null}
          </span>
        </button>
        {stat ? (
          <>
            {sep}
            {stat}
          </>
        ) : null}
      </>
    );
  } else if (text.sources) {
    bar = (
      <button
        type="button"
        className="px-sources-row"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          hide();
          setOpen((now) => !now);
        }}
      >
        <span>{text.sources}</span>
        {text.checks ? (
          <>
            {sep}
            <span>{text.checks}</span>
          </>
        ) : null}
        <span className="px-chevron" aria-hidden />
      </button>
    );
  } else bar = stat;

  return (
    <div ref={box} className={`px-sources is-${variant}${arriving ? " is-arriving" : ""}`}>
      <div className="px-sources-bar">{bar}</div>
      {text.sources ? (
        <div ref={fold} className={open ? "px-sources-fold is-open" : "px-sources-fold"} id={listId} inert={!open}>
          <div>
            <ul className="px-sources-list" aria-label={t("sourcesRow.list")}>
              {groups.map((group) => (
                <li key={group.key} className="px-sources-source">
                  <button
                    type="button"
                    className="px-sources-name"
                    // A source with one place opens there; one with several opens at its start.
                    onClick={() =>
                      openSourceViewer(
                        group.sourceId && group.places.length > 1
                          ? { sourceId: group.sourceId }
                          : { passageId: group.places[0]!.passageId },
                      )
                    }
                    onPointerEnter={() => tint(host(), group.places.flatMap((place) => place.numbers))}
                    onPointerLeave={() => tint(null, [])}
                    onFocus={() => tint(host(), group.places.flatMap((place) => place.numbers))}
                    onBlur={() => tint(null, [])}
                  >
                    {group.title}
                  </button>
                  {group.places.some((place) => place.label) ? (
                    <span className="px-sources-places">
                      {group.places.map((place) => (
                        <button
                          key={place.passageId}
                          type="button"
                          className="px-sources-place"
                          aria-label={placeName(t, group.title, place)}
                          {...placeProps(place, group)}
                        >
                          {place.label ? placeText(t, place.label) : null}
                        </button>
                      ))}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      {card ? <PassageCard id={cardId} card={card} /> : null}
    </div>
  );
}

/** A place's name for a screen reader: its source and its place, with the words the place shows, as "Analisi 2, p. 172". */
function placeName(t: TFunction, title: string, place: ListedPlace): string | undefined {
  return place.label ? t("sourcesRow.placeAria", { title, place: placeText(t, place.label) }) : undefined;
}

/** The passage of a place, over or under it: where it comes from, its words, and what a click does. */
function PassageCard({ id, card }: { id: string; card: Card }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const passage = useQuery({
    ...passageQuery(card.place.passageId),
    select: (rows) => rows.find((row) => row.current)?.text ?? "",
  });
  const place = useCallback(() => {
    const element = ref.current;
    if (!element || !card.anchor.isConnected) return;
    const at = card.anchor.getBoundingClientRect();
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, at.left - 14));
    // In the list the card opens above the place, so it covers the list rather than the text it tints.
    const above = at.top - height - 8 >= 12;
    element.style.left = `${left}px`;
    element.style.top = `${above ? at.top - height - 8 : at.bottom + 8}px`;
    element.style.transformOrigin = `${Math.round(at.left + at.width / 2 - left)}px ${above ? "100%" : "0"}`;
  }, [card.anchor]);
  useLayoutEffect(place, [place, passage.data]);
  useEffect(() => {
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [place]);
  const where = card.place.label ? placeText(t, card.place.label) : null;
  // Drawn in the row, so it stays in the page's landmarks; fixed, so the list's fold does not clip it.
  return (
    <div ref={ref} id={id} className="px-passage-card" role="tooltip">
      <small>{[card.title, where].filter(Boolean).join(" · ")}</small>
      {passage.data ? <p>«{excerpt(passage.data)}»</p> : passage.isPending ? <p className="is-reading">{t("sourcesRow.reading")}</p> : null}
      <span className="px-passage-hint">{t("sourcesRow.hint")}</span>
    </div>
  );
}
