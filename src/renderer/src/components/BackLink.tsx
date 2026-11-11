import { Link } from "react-router";
import { Icon } from "./Icon";
import "./BackLink.css";

/**
 * The way back at the top of a page that is not a sidebar section: an arrow and the name of the place it leads to,
 * above the page's title. Study pages put theirs in the study bar instead.
 */
export function BackLink({ to, children }: { to: string; children: string }) {
  return (
    <Link to={to} className="px-subpage-back">
      <Icon name="arrow-left" size={16} />
      {children}
    </Link>
  );
}
