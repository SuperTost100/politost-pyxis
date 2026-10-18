import { Button, Dropdown, Input, Space, type MenuProps } from "antd";
import { ChevronDown, Search, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import "./ListToolbar.css";

/**
 * The toolbar above every list on the Exams page and the plan's Sources tab, always in one order: the search
 * field, the filters, a secondary menu and the one primary action. No field has a visible label; each control
 * carries its own accessible name. A caller leaves out the filters while its list is empty.
 */
export function ListToolbar(props: {
  search?: ReactNode;
  filters?: ReactNode;
  menu?: ReactNode;
  primary?: ReactNode;
}) {
  return (
    <div className="px-list-toolbar">
      {props.search}
      <div className="px-list-toolbar-rest">
        {props.filters}
        {props.menu || props.primary ? (
          <div className="px-list-toolbar-actions">
            {props.menu}
            {props.primary}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The toolbar's search field, with the search icon. `scope` sits joined to its end, as one field. */
export function ToolbarSearch(props: {
  id?: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onPressEnter?: () => void;
  scope?: ReactNode;
}) {
  const { t } = useTranslation();
  const field = (
    <Input
      id={props.id}
      aria-label={props.label}
      placeholder={props.placeholder}
      prefix={<Search size={16} strokeWidth={1.75} aria-hidden />}
      allowClear={{
        clearIcon: (
          <X
            size={14}
            strokeWidth={1.75}
            role="img"
            aria-label={t("listToolbar.clearSearch")}
          />
        ),
      }}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      onPressEnter={props.onPressEnter}
    />
  );
  return props.scope ? (
    <Space.Compact className="px-list-toolbar-search has-scope">
      {field}
      {props.scope}
    </Space.Compact>
  ) : (
    <div className="px-list-toolbar-search">{field}</div>
  );
}

/**
 * A secondary menu: a round button with its label and a chevron that turns while the menu is open. The menu
 * opens outside the page's landmarks, so a named region keeps it in one.
 */
export function ToolbarMenu(props: {
  label: string;
  items: NonNullable<MenuProps["items"]>;
  onSelect: (key: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Dropdown
      trigger={["click"]}
      open={open}
      onOpenChange={setOpen}
      disabled={props.disabled}
      autoFocus
      popupRender={(menu) => (
        <div role="region" aria-label={props.label}>
          {menu}
        </div>
      )}
      menu={{
        items: props.items,
        onClick: ({ key }) => {
          setOpen(false);
          // Focus goes back to the button before the item acts, so a dialog it opens returns focus there on close.
          trigger.current?.focus();
          props.onSelect(key);
        },
      }}
    >
      <Button
        ref={trigger}
        shape="round"
        disabled={props.disabled}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="px-list-toolbar-menu">
          {props.label}
          <ChevronDown
            size={16}
            strokeWidth={1.75}
            aria-hidden
            className={open ? "is-open" : ""}
          />
        </span>
      </Button>
    </Dropdown>
  );
}
