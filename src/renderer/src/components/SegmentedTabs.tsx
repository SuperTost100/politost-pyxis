import { Segmented } from "antd";
import { useState } from "react";
import { Icon, type IconName } from "./Icon";
import "./SegmentedTabs.css";

export type SegmentedItem = {
  value: string;
  label: string;
  icon?: IconName;
  badge?: string;
};

export function SegmentedTabs({
  items,
  value: controlled,
  onChange,
  label,
}: {
  items: SegmentedItem[];
  value?: string;
  onChange?: (value: string) => void;
  label?: string;
}) {
  const [internal, setInternal] = useState(items[0]?.value ?? "");
  const value = controlled ?? internal;
  return (
    <div className="px-seg-wrap">
      <Segmented
        className="px-seg"
        aria-label={label}
        value={value}
        onChange={(v) => {
          const next = String(v);
          setInternal(next);
          onChange?.(next);
        }}
        options={items.map((it) => ({
          value: it.value,
          label: (
            <span className="px-seg-item-inner">
              {it.icon ? <Icon name={it.icon} size={16} /> : null}
              {it.label}
              {it.badge ? <span className="px-seg-badge">{it.badge}</span> : null}
            </span>
          ),
        }))}
      />
    </div>
  );
}
