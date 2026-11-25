import { useQueries } from "@tanstack/react-query";
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
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
  type RefObject,
  type ReactNode,
} from "react";
import type { TFunction } from "i18next";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { MathCheck } from "@shared/math-check";
import { passageQuery } from "../lib/passagePlaces";
import { useCheckTally } from "../lib/mathChecks";
import { citedRanges } from "../lib/citedRanges";
import { renderedText } from "../lib/renderedText";
import { listedPlaceText, rowText, sourceGroups, sourceName, type CitedPlace, type ListedPlace, type SourceGroup } from "../lib/sourcePlaces";
import { openSourceViewer } from "./SourceViewer";
import "./SourcesRow.css";

/** The name of the CSS highlight that tints the words a pointed-at passage supports (`::highlight(px-cited)`). */
const TINT = "px-cited";
/** A pointer that only crosses the list opens no passage. */
const HOVER_DELAY = 110;
/** How long a card stays after the pointer leaves its place, so the pointer can move onto a card that scrolls. */
const LEAVE_DELAY = 150;
/** The card's distance from its place and from the window's edges. */
const GAP = 8;
const EDGE = 12;

/** Words cut at a word near `length` characters, as the card shows them. */
function excerpt(text: string, length = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= length) return flat;
  return `${flat.slice(0, length).replace(/\s+\S*$/, "")}…`;
}

/** The words in `host` that rest on passage `n`, as a reader sees them (each formula read once). */
function sentenceOf(host: HTMLElement | null, n: number): string {
  if (!host) return "";
  return citedRanges(host, new Set([n]))
    .map((range) => {
      const holder = document.createElement("div");
      holder.append(range.cloneContents());
      return renderedText(holder);
    })
    .join(" … ");
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

/** The card of a place, and for a place that stands for several passages, the start of the sentence each one supports. */
type Card = { place: ListedPlace; title: string; anchor: HTMLElement; sentences: Record<number, string> };

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
  const cardBox = useRef<HTMLDivElement>(null);
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
        const element = host();
        const sentences =
          place.passages.length > 1
            ? Object.fromEntries(place.passages.map(({ n }) => [n, excerpt(sentenceOf(element, n), 60)]))
            : {};
        setCard({ place, title, anchor, sentences });
        tint(element, place.numbers);
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
    onPointerEnter: (event: PointerEvent<HTMLElement>) => show(place, sourceName(t, group), event.currentTarget, true),
    // A card that scrolls can be reached with the pointer: leaving the place for it keeps it open.
    onPointerLeave: () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(hide, LEAVE_DELAY);
    },
    onFocus: (event: FocusEvent<HTMLElement>) => show(place, sourceName(t, group), event.currentTarget, false),
    // Focus moving into the card keeps it.
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (event.relatedTarget instanceof Node && cardBox.current?.contains(event.relatedTarget)) return;
      hide();
    },
    // From the keyboard, the arrows, Page Up and Down, Home and End read a card too long for the window.
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      const box = cardBox.current;
      if (!box || box.scrollHeight <= box.clientHeight + 1) return;
      const page = box.clientHeight - 40;
      const by: Record<string, number> = { ArrowDown: 40, ArrowUp: -40, PageDown: page, PageUp: -page };
      if (event.key === "Home") box.scrollTop = 0;
      else if (event.key === "End") box.scrollTop = box.scrollHeight;
      else if (event.key in by) box.scrollTop += by[event.key]!;
      else return;
      event.preventDefault();
    },
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
    const where = place.label ? listedPlaceText(t, place) : null;
    bar = (
      <>
        <button
          type="button"
          className="px-sources-row is-link"
          aria-label={placeName(t, sourceName(t, group), place)}
          {...placeProps(place, group)}
        >
          <span>
            <b>{sourceName(t, group)}</b>
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
                    {sourceName(t, group)}
                  </button>
                  {group.places.some((place) => place.label) ? (
                    <span className="px-sources-places">
                      {group.places.map((place) => (
                        <button
                          key={place.passageId}
                          type="button"
                          className={place.label?.kind === "section" ? "px-sources-place is-section" : "px-sources-place"}
                          aria-label={placeName(t, sourceName(t, group), place)}
                          {...placeProps(place, group)}
                        >
                          {place.label ? listedPlaceText(t, place) : null}
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
      {card
        ? createPortal(
        <PassageCard
          id={cardId}
          card={card}
          cardRef={cardBox}
          onPointerEnter={() => window.clearTimeout(timer.current)}
          onPointerLeave={hide}
          onBlur={(event) => {
            if (event.relatedTarget !== card.anchor) hide();
          }}
        />,
            // Out of the message, whose `content-visibility` would make it the card's frame instead of the window, and into
            // the page's main landmark, where a screen reader finds it with the page.
            box.current?.closest("main") ?? document.body,
          )
        : null}
    </div>
  );
}

/** A place's name for a screen reader: its source and its place, with the words the place shows, as "Analisi 2, p. 172". */
function placeName(t: TFunction, title: string, place: ListedPlace): string | undefined {
  return place.label ? t("sourcesRow.placeAria", { title, place: listedPlaceText(t, place) }) : undefined;
}

/**
 * The passage of a place, over or under it: where it comes from, its words, and what a click does. A place that stands
 * for several passages (two cited on one page) quotes each one, introduced by the start of the sentence it supports,
 * whose words are tinted with the others.
 */
function PassageCard({
  id,
  card,
  cardRef: ref,
  onPointerEnter,
  onPointerLeave,
  onBlur,
}: {
  id: string;
  card: Card;
  cardRef: RefObject<HTMLDivElement | null>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onBlur: (event: FocusEvent<HTMLDivElement>) => void;
}) {
  const { t } = useTranslation();
  const several = card.place.passages.length > 1;
  const quotes = useQueries({
    queries: card.place.passages.map(({ passageId }) => ({
      ...passageQuery(passageId),
      // The cited passage's own words: the current row can be the whole page, merged for the source viewer.
      select: (rows: Array<{ current: boolean; quote?: string; text: string }>) => {
        const current = rows.find((row) => row.current);
        return current?.quote ?? current?.text ?? "";
      },
    })),
  });
  const place = useCallback(() => {
    const element = ref.current;
    if (!element || !card.anchor.isConnected) return;
    const at = card.anchor.getBoundingClientRect();
    const width = element.offsetWidth;
    // The whole card, however much of it shows: scrollHeight does not change with the height it is given.
    const natural = element.scrollHeight;
    const left = Math.max(EDGE, Math.min(window.innerWidth - width - EDGE, at.left - 14));
    // Above the place when it fits there, so it covers the list rather than the text it tints; else below when it fits
    // there; else on the side with more room. It never runs past the window: what does not fit scrolls inside it.
    // Measured from the part of the place inside the window, so a place half out of view still keeps the card in it.
    const top = Math.min(Math.max(at.top, 0), window.innerHeight);
    const bottom = Math.min(Math.max(at.bottom, 0), window.innerHeight);
    const roomAbove = top - GAP - EDGE;
    const roomBelow = window.innerHeight - bottom - GAP - EDGE;
    const above = natural <= roomAbove || (natural > roomBelow && roomAbove > roomBelow);
    const room = Math.max(0, above ? roomAbove : roomBelow);
    const height = Math.min(natural, room);
    element.style.maxHeight = `${room}px`;
    const overflow = natural > room + 1;
    element.toggleAttribute("data-overflow", overflow);
    // A card that scrolls is a stop for the keyboard too, where the arrows read it as in any scrolling box.
    element.tabIndex = overflow ? 0 : -1;
    element.style.left = `${left}px`;
    element.style.top = `${above ? top - GAP - height : bottom + GAP}px`;
    element.style.transformOrigin = `${Math.round(at.left + at.width / 2 - left)}px ${above ? "100%" : "0"}`;
  }, [card.anchor]);
  const loaded = quotes.map((quote) => quote.data ?? "").join("\n");
  useLayoutEffect(place, [place, loaded]);
  useEffect(() => {
    // The page scrolling moves the place; the card scrolling its own quotes does not.
    const onScroll = (event: Event) => {
      if (event.target !== ref.current) place();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [place]);
  const where = card.place.label ? listedPlaceText(t, card.place) : null;
  // Fixed to the window, so the list's fold does not clip it.
  return (
    <div ref={ref} id={id} className="px-passage-card" role="tooltip" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} onBlur={onBlur}>
      <small>{[card.title, where].filter(Boolean).join(" · ")}</small>
      {card.place.passages.map(({ n }, index) => {
        const quote = quotes[index];
        return (
          <div key={n} className="px-passage-quote">
            {several && card.sentences[n] ? <span className="px-passage-for">{t("sourcesRow.supports", { sentence: card.sentences[n] })}</span> : null}
            {quote?.data ? (
              <p>«{excerpt(quote.data, several ? 180 : 280)}»</p>
            ) : quote?.isPending ? (
              <p className="is-reading">{t("sourcesRow.reading")}</p>
            ) : null}
          </div>
        );
      })}
      <span className="px-passage-hint">{t("sourcesRow.hint")}</span>
      <span className="px-passage-hint is-scroll">{t("sourcesRow.scrollHint")}</span>
    </div>
  );
}
