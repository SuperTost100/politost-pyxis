/** Windows paths use `\`, so a `/` split alone shows the whole path. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

const PNG_PREFIX = "data:image/png;base64,";

/**
 * The whiteboard hands Ask one staged file and, with it, the image it staged.
 * Both leave sessionStorage here, so a preview never outlives its attachment or shows for a board that was only saved.
 */
export function takeBoardAttachment(
  store: Pick<Storage, "getItem" | "removeItem">,
): { path: string; preview?: string } | null {
  const path = store.getItem("pyxis-board-file");
  const png = store.getItem("pyxis-board-png");
  store.removeItem("pyxis-board-file");
  store.removeItem("pyxis-board-png");
  if (!path) return null;
  return png?.startsWith(PNG_PREFIX) ? { path, preview: png } : { path };
}
