import { useQueryClient } from "@tanstack/react-query";
import { App, type MenuProps } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MapAddress } from "@shared/concept-map";
import { invoke } from "../../lib/ipc";
import { Icon } from "../../components/Icon";
import { useMapExport } from "./MapExport";
import { mapMenu, type MapMenuEntry, type MapMenuState } from "./mapMenu";
import "./MapActions.css";

/** The queries that show a map anywhere: Mappe, the map page, the exam page's maps, the search and Attività. */
export function forgetMaps(client: ReturnType<typeof useQueryClient>) {
  return Promise.all(
    [["maps"], ["maps-all"], ["map"], ["map-build"], ["jobs"]].map((queryKey) =>
      client.invalidateQueries({ queryKey }),
    ),
  );
}

/**
 * One map's actions for its menu, the same on the map page and on its tile: rename, export and delete. Renaming happens
 * in place, so `onRename` hands it to the place that shows the name. Deleting asks once, in a dialog where only the
 * confirming button is solid red and Annulla has the focus; there is no undo. A map still being written is named by its
 * build (`jobId`), and deleting it stops the build. `exportView` saves the part on screen, on the map page only.
 * `deleting` and `failed` follow a delete made here.
 */
export function useMapActions(props: {
  address: MapAddress;
  mapId?: string;
  jobId?: string;
  /** The map's name, which the confirmation repeats. */
  title: string;
  state: Omit<MapMenuState, "exporting" | "view">;
  settle?: () => Promise<unknown>;
  exportView?: () => void;
  onOpen?: () => void;
  onRename: () => void;
  /**
   * Takes the confirmed delete over, as the map page does to let the map leave from its tile on Mappe. Without it the
   * map is deleted here and `onDeleted` follows.
   */
  onDelete?: () => void;
  /** After the map is gone, before the queries that showed it are read again. */
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const { modal } = App.useApp();
  const client = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  // A delete that failed says so next to the map, until the next try.
  const [failed, setFailed] = useState(false);
  const mapExport = useMapExport({
    address: props.address,
    mapId: props.mapId,
    settle: props.settle ?? (() => Promise.resolve()),
  });

  async function remove() {
    setDeleting(true);
    setFailed(false);
    try {
      await invoke("maps.delete", {
        ...props.address,
        ...(props.mapId ? { mapId: props.mapId } : { jobId: props.jobId }),
      });
      props.onDeleted?.();
      void forgetMaps(client);
    } catch {
      setFailed(true);
    } finally {
      setDeleting(false);
    }
  }
  function confirmDelete() {
    setFailed(false);
    void modal.confirm({
      title: t("map.deleteTitle", { title: props.title }),
      content: t(props.state.writing ? "map.deleteWritingBody" : "map.deleteBody"),
      icon: null,
      className: "px-map-confirm",
      width: 520,
      okText: t("map.deleteConfirm"),
      okButtonProps: { danger: true },
      cancelText: t("map.cancel"),
      cancelButtonProps: { type: "text", className: "px-btn px-btn-ghost" },
      // Something that cannot be undone never has the focus first.
      autoFocusButton: "cancel",
      onOk: () => (props.onDelete ? props.onDelete() : void remove()),
    });
  }

  const label = (entry: Extract<MapMenuEntry, { kind: "action" }>) => {
    switch (entry.key) {
      case "open":
        return t("map.open");
      case "rename":
        return t("map.renameMap");
      case "export":
        return t("map.export");
      case "delete":
        return t("map.deleteMap");
      default:
        return t(`map.exportAs.${entry.key.slice("export-".length)}`);
    }
  };
  const items = (entries: MapMenuEntry[]): NonNullable<MenuProps["items"]> =>
    entries.map((entry) =>
      entry.kind === "divider"
        ? { type: "divider", key: entry.key }
        : entry.children
          ? { key: entry.key, label: label(entry), disabled: entry.disabled, children: items(entry.children) }
          : {
              key: entry.key,
              label: label(entry),
              disabled: entry.disabled || (entry.key === "delete" && deleting),
              danger: entry.danger,
              extra: entry.key.startsWith("export-") ? t(`map.exportFormat.${entry.key.slice("export-".length)}`) : undefined,
            },
    );
  const menu: MenuProps = {
    items: items(mapMenu({ ...props.state, exporting: mapExport.busy, view: Boolean(props.exportView) })),
    expandIcon: <Icon name="chevron-right" size={14} className="px-item-menu-arrow" />,
    onClick: ({ key }) => {
      if (key === "open") props.onOpen?.();
      else if (key === "rename") props.onRename();
      else if (key === "delete") confirmDelete();
      else if (key === "export-png") props.exportView?.();
      else if (key === "export-markdown" || key === "export-svg" || key === "export-pdf")
        void mapExport.save(key.slice("export-".length) as "markdown" | "svg" | "pdf");
    },
  };
  return { menu, deleting, failed };
}

/**
 * The map's name, edited where it shows (the page's title, a tile's caption). Enter saves, Escape and leaving it unchanged
 * cancel, and a name made only of spaces is refused with a word under the field, on Enter and on leaving the field alike.
 * Leaving the field with a new name saves it. `onDone` gets the saved name, or nothing when the name stays as it was; focus is the caller's to place.
 */
export function MapNameField(props: {
  address: MapAddress;
  mapId: string;
  value: string;
  className?: string;
  onDone: (saved?: string) => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [text, setText] = useState(props.value);
  const [problem, setProblem] = useState<"empty" | "failed" | null>(null);
  const [saving, setSaving] = useState(false);
  const errorId = `map-name-error-${props.mapId}`;

  async function save() {
    const name = text.trim();
    if (!name) return setProblem("empty");
    if (name === props.value) return props.onDone();
    setSaving(true);
    try {
      await invoke("maps.rename", { ...props.address, mapId: props.mapId, title: name });
      await forgetMaps(client);
      props.onDone(name);
    } catch {
      setProblem("failed");
      setSaving(false);
    }
  }
  return (
    <span className={["px-map-name", props.className].filter(Boolean).join(" ")}>
      <input
        // The field takes the place of the name the student asked to change, so it takes the focus too.
        autoFocus
        className="px-map-name-field"
        aria-label={t("map.nameLabel")}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? errorId : undefined}
        value={text}
        maxLength={500}
        readOnly={saving}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          setText(event.target.value);
          setProblem(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.onDone();
          }
        }}
        onBlur={() => {
          if (saving) return;
          // An empty name stays open with its word, as Enter leaves it; only an unchanged name closes the field.
          if (text.trim() === props.value) props.onDone();
          else void save();
        }}
      />
      {problem ? (
        <span className="px-map-name-error" id={errorId} role="alert">
          {t(problem === "empty" ? "map.nameEmpty" : "map.renameFailed")}
        </span>
      ) : null}
    </span>
  );
}
