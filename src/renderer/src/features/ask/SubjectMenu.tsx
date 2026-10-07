import { useQuery } from "@tanstack/react-query";
import { Input, Popover } from "antd";
import { Check, ChevronDown, GraduationCap, Settings2 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../lib/ipc";
import { focusMenu, menuKeys } from "./menuKeys";
import { SubjectManagerModal } from "./SubjectPicker";
import "./AskMenus.css";

/** The one subject control: a chip in the composer that opens the subjects, "no subject" and the manager. */
export function SubjectMenu({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const subjects = useQuery({
    queryKey: ["subjects"],
    queryFn: () => invoke("subjects.list", {}),
  });
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const names = (subjects.data ?? []).map((row) => row.name);
  if (value && !names.includes(value)) names.push(value);
  const searchable = names.length > 6;
  const shown = searchable
    ? names.filter((name) =>
        name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      )
    : names;

  function close(returnFocus = true) {
    setOpen(false);
    setQuery("");
    if (returnFocus) trigger.current?.focus();
  }
  function pick(next: string) {
    close();
    onChange(next);
  }

  const content = (
    <div className="ask-menu" role="region" aria-label={t("ask.subject")} ref={focusMenu}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
        menuKeys(event);
      }}
    >
      {searchable ? (
        <Input
          className="ask-menu-search"
          allowClear
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t("ask.subjectSearch")}
          placeholder={t("ask.subjectSearch")}
        />
      ) : null}
      <ul className="ask-menu-list">
        <li>
          <button
            type="button"
            aria-pressed={value === ""}
            className="ask-menu-item"
            onClick={() => pick("")}
          >
            <span>{t("ask.subjectNone")}</span>
            {value === "" ? <Check size={16} aria-hidden /> : null}
          </button>
        </li>
        {shown.map((name) => (
          <li key={name}>
            <button
              type="button"
              aria-pressed={value === name}
              className="ask-menu-item"
              onClick={() => pick(name)}
            >
              <span>{name}</span>
              {value === name ? <Check size={16} aria-hidden /> : null}
            </button>
          </li>
        ))}
      </ul>
      {searchable && shown.length === 0 ? (
        <p className="small ask-menu-empty">{t("ask.subjectNoMatch")}</p>
      ) : null}
      <div className="ask-menu-foot">
        <button
          type="button"
          className="ask-menu-item"
          onClick={() => {
            close(false);
            setManaging(true);
          }}
        >
          <Settings2 size={16} aria-hidden />
          <span>{t("ask.manageSubjects")}</span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      <Popover
        open={open && !disabled}
        onOpenChange={(next) => (next ? setOpen(true) : close(false))}
        trigger="click"
        placement="topLeft"
        arrow={false}
        rootClassName="ask-popover"
        content={content}
      >
        <button
          ref={trigger}
          type="button"
          className="px-subject"
          disabled={disabled}
          aria-expanded={open}
          aria-label={t("ask.subjectMenu", {
            name: value || t("ask.subjectNone"),
          })}
        >
          <GraduationCap size={14} aria-hidden />
          <span>{value || t("ask.subjectNone")}</span>
          <ChevronDown size={14} aria-hidden className="px-chip-caret" />
        </button>
      </Popover>
      <SubjectManagerModal
        open={managing}
        onClose={() => setManaging(false)}
        value={value}
        onChange={onChange}
      />
    </>
  );
}
