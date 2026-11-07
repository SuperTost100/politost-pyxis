type Node = { id: string; label: string; parent: string | null };

/**
 * What an AI edit did to a map, for the line under the map: the one concept it added and where, or only that it
 * changed the map when it did anything else.
 */
export function describeChange(
  before: Node[],
  after: Node[],
): { kind: "added"; label: string; parent: string } | { kind: "changed" } {
  const was = new Map(before.map((node) => [node.id, node]));
  const added = after.filter((node) => !was.has(node.id));
  const changed =
    after.length - added.length !== before.length ||
    after.some((node) => {
      const old = was.get(node.id);
      return old && (old.label !== node.label || old.parent !== node.parent);
    });
  const parent =
    added.length === 1 && !changed
      ? after.find((node) => node.id === added[0]!.parent)
      : undefined;
  return parent
    ? { kind: "added", label: added[0]!.label, parent: parent.label }
    : { kind: "changed" };
}
