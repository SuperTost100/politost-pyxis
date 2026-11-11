/**
 * The state a page is opened with (`build`, for one) belongs to the history entry that carried it, and the entry keeps
 * it until the page takes it out. The page cannot always do that: it must not cancel a navigation that is under way.
 * So the page notes in the window's session storage that it acted on this entry, under the entry's own key, which
 * Back, Forward and a reload of the entry all keep. Returns true the first time a name and entry are claimed, and
 * false after that. Without a usable storage it returns true, and the page falls back on taking the state out.
 */
export function claimOnce(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  name: string,
  entryKey: string,
): boolean {
  const slot = `pyxis.once.${name}.${entryKey}`;
  try {
    if (!storage) return true;
    if (storage.getItem(slot)) return false;
    storage.setItem(slot, "1");
  } catch {
    return true;
  }
  return true;
}

/** Whether the name and entry were claimed already, without claiming them. */
export function wasClaimed(
  storage: Pick<Storage, "getItem"> | undefined,
  name: string,
  entryKey: string,
): boolean {
  try {
    return Boolean(storage?.getItem(`pyxis.once.${name}.${entryKey}`));
  } catch {
    return false;
  }
}
