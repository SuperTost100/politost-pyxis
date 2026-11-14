import { ArrowLeft } from "lucide-react";
import type { BackTarget } from "../app/usePlace";
import "./BackControl.css";

/**
 * The one way back of a page that was opened from another (docs/design-system/layout.md, "Going back"): an arrow and
 * the name of the place it leads to, top left. `page` sits above a shell page's title; `bar` at the left end of the
 * study bar. It is a button, because it moves through the window's history (`usePlace`), and it draws nothing when the
 * page has no way back.
 */
export function BackControl({ target, variant }: { target: BackTarget | null; variant: "page" | "bar" }) {
  if (!target) return null;
  return (
    <button
      type="button"
      className={`px-back is-${variant}`}
      aria-label={target.label}
      aria-disabled={target.busy || undefined}
      title={target.name}
      onClick={target.go}
    >
      <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
      <span className="px-back-text">{target.name}</span>
    </button>
  );
}
