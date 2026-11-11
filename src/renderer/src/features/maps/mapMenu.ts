/**
 * What a map's menu holds, free of the page so a unit test reads it. The map page's dots and a right-click on its empty
 * canvas open the same menu; a tile on Mappe opens the tile's, which starts with Apri. Each holds actions on the map
 * only: Rinomina, Esporta with the formats as a submenu, and after a hairline "Elimina la mappa…". Keyboard shortcuts
 * live in Help's shortcuts dialog, never in a menu.
 */

/** A format a map can be saved as. `png` is the part of the map on screen, so only the map page offers it. */
export type MapExportChoice = "markdown" | "svg" | "pdf" | "png";

export type MapMenuEntry =
  | { kind: "divider"; key: string }
  | {
      kind: "action";
      key: "open" | "rename" | "export" | "delete" | `export-${MapExportChoice}`;
      disabled?: boolean;
      danger?: boolean;
      children?: MapMenuEntry[];
    };

/** What the place the menu opens from knows about the map. */
export type MapMenuState = {
  /** The tile's menu, which offers Apri; the map page shows the map already. */
  tile?: boolean;
  /**
   * The map is still being written, so there is nothing yet to rename or export. Deleting it stops its build, and the
   * build never stores it.
   */
  writing?: boolean;
  /** Something else is changing the map now (an edit, an undo), so renaming waits for it. */
  busy?: boolean;
  /** An export is running; another waits until it is done. */
  exporting?: boolean;
  /** The map page can save the view on screen as a picture. */
  view?: boolean;
};

export function mapMenu(state: MapMenuState): MapMenuEntry[] {
  const formats: MapExportChoice[] = state.view ? ["markdown", "svg", "pdf", "png"] : ["markdown", "svg", "pdf"];
  const nothingYet = Boolean(state.writing);
  return [
    ...(state.tile ? [{ kind: "action" as const, key: "open" as const }] : []),
    { kind: "action", key: "rename", disabled: nothingYet || state.busy },
    {
      kind: "action",
      key: "export",
      disabled: nothingYet,
      children: formats.map((format) => ({
        kind: "action" as const,
        key: `export-${format}` as const,
        disabled: Boolean(state.exporting),
      })),
    },
    { kind: "divider", key: "before-delete" },
    { kind: "action", key: "delete", danger: true },
  ];
}

/**
 * How the switcher and its list name a map: by what the student asked for, in «», or "Mappa completa" (`whole`) for a
 * map made without a request. Long requests are cut by the layout, never here.
 */
export function requestName(map: { instruction?: string | null }, whole: string): string {
  const asked = map.instruction?.trim();
  return asked ? `«${asked}»` : whole;
}

/**
 * Where focus goes after the tile `removed` leaves a list of tiles in `order`: the tile that takes its place, else the
 * one before it, else nothing (the page's first action then takes it).
 */
export function focusAfterRemoval(order: string[], removed: string): string | undefined {
  const at = order.indexOf(removed);
  if (at < 0) return order[0];
  return order[at + 1] ?? order[at - 1];
}
