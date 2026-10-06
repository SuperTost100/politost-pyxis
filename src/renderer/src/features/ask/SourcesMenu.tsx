import { Input, Popover } from "antd";
import { ArrowLeft, BookOpen, ChevronDown, Plus, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { focusMenu, menuKeys } from "./menuKeys";
import type { ScopeItem } from "./scope";
import "./AskMenus.css";

type Entry = { id: string; title: string };

/** The Fonti chip: how many sources the chat reads, and a popover to remove them or add others from the library. */
export function SourcesMenu({
  items,
  library,
  plans,
  onRemove,
  onAddSource,
  onAddPlan,
  disabled,
}: {
  items: ScopeItem[];
  library: Entry[];
  plans: Entry[];
  onRemove: (item: ScopeItem) => void;
  onAddSource: (id: string) => void;
  onAddPlan: (id: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const menu = useRef<HTMLDivElement | null>(null);
  const attach = useCallback((node: HTMLDivElement | null) => {
    menu.current = node;
    focusMenu(node);
  }, []);
  const trigger = useRef<HTMLButtonElement>(null);
  const label =
    items.length === 0
      ? t("ask.sourcesChipNone")
      : t("ask.sourcesChip", { count: items.length });

  const used = new Set(items.map((item) => item.id));
  const needle = query.trim().toLocaleLowerCase();
  const matches = (entry: Entry) =>
    entry.title.toLocaleLowerCase().includes(needle);
  const addableSources = library.filter((entry) => !used.has(entry.id));
  const addablePlans = plans.filter((entry) => !used.has(entry.id));
  const searchable = addableSources.length + addablePlans.length > 8;

  function close(returnFocus = false) {
    setOpen(false);
    setAdding(false);
    setQuery("");
    if (returnFocus) trigger.current?.focus();
  }
  function focusFirst() {
    // Wait for the view to render before moving focus into it.
    requestAnimationFrame(() =>
      menu.current
        ?.querySelector<HTMLElement>("input, button")
        ?.focus(),
    );
  }

  const list = (
    <>
      <div className="ask-menu-head">
        <span className="label">{t("ask.sources")}</span>
      </div>
      {items.length === 0 ? (
        <p className="small ask-menu-empty">{t("ask.sourcesEmpty")}</p>
      ) : (
        <ul className="ask-menu-list">
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`} className="ask-source-row">
              <span className="ask-source-title">
                {item.kind === "plan"
                  ? t("ask.sourcesFromPlan", { title: item.title })
                  : item.title}
              </span>
              {item.locked ? null : (
                <button
                  type="button"
                          className="ask-menu-icon"
                  aria-label={t("ask.removeSource", { title: item.title })}
                  onClick={() => {
                    onRemove(item);
                    focusFirst();
                  }}
                >
                  <X size={16} aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="ask-menu-foot">
        <button
          type="button"
          className="ask-menu-item"
          onClick={() => {
            setAdding(true);
            focusFirst();
          }}
        >
          <Plus size={16} aria-hidden />
          <span>{t("ask.sourcesAdd")}</span>
        </button>
      </div>
    </>
  );

  const picker = (
    <>
      <div className="ask-menu-head">
        <button
          type="button"
          className="ask-menu-icon"
          aria-label={t("ask.sourcesBack")}
          onClick={() => {
            setAdding(false);
            setQuery("");
            focusFirst();
          }}
        >
          <ArrowLeft size={16} aria-hidden />
        </button>
        <span className="label">{t("ask.sourcesAddTitle")}</span>
      </div>
      {searchable ? (
        <Input
          className="ask-menu-search"
          allowClear
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t("ask.sourcesSearch")}
          placeholder={t("ask.sourcesSearch")}
        />
      ) : null}
      {addablePlans.filter(matches).length > 0 ? (
        <>
          <p className="label ask-menu-group">{t("ask.sourcesPlans")}</p>
          <ul className="ask-menu-list">
            {addablePlans.filter(matches).map((plan) => (
              <li key={plan.id}>
                <button
                  type="button"
                          className="ask-menu-item"
                  onClick={() => onAddPlan(plan.id)}
                >
                  <span>{plan.title}</span>
                  <Plus size={16} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {addableSources.filter(matches).length > 0 ? (
        <>
          <p className="label ask-menu-group">{t("ask.sourcesLibrary")}</p>
          <ul className="ask-menu-list">
            {addableSources.filter(matches).map((source) => (
              <li key={source.id}>
                <button
                  type="button"
                          className="ask-menu-item"
                  onClick={() => onAddSource(source.id)}
                >
                  <span>{source.title}</span>
                  <Plus size={16} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {addablePlans.filter(matches).length +
        addableSources.filter(matches).length ===
      0 ? (
        <p className="small ask-menu-empty">{t("ask.sourcesNothingToAdd")}</p>
      ) : null}
    </>
  );

  return (
    <Popover
      open={open && !disabled}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
      trigger="click"
      placement="topLeft"
      arrow={false}
      rootClassName="ask-popover"
      content={
        <div
          className="ask-menu"
          role="region"
          aria-label={t("ask.sources")}
          ref={attach}
          onKeyDown={(event) => {
            if (event.key === "Escape") close(true);
            menuKeys(event);
          }}
        >
          {adding ? picker : list}
        </div>
      }
    >
      <button
        ref={trigger}
        type="button"
        className={items.length === 0 ? "px-source-chip is-empty" : "px-source-chip"}
        disabled={disabled}
        aria-expanded={open}
      >
        <BookOpen size={14} aria-hidden />
        <span>{label}</span>
        <ChevronDown size={14} aria-hidden className="px-chip-caret" />
      </button>
    </Popover>
  );
}
