/**
 * The map's keys, listed under Maps in Help > Keyboard shortcuts, the one place that lists shortcuts. Each row's label is
 * `map.keys.<id>`, and `either` marks keys that each do the same thing.
 */
export const MAP_KEYS: ReadonlyArray<{
  id: "select" | "rename" | "delete" | "move";
  keys: string[];
  either?: boolean;
}> = [
  { id: "select", keys: ["Tab"] },
  { id: "rename", keys: ["enter"] },
  { id: "delete", keys: ["delete", "backspace"], either: true },
  { id: "move", keys: ["arrows"] },
];
