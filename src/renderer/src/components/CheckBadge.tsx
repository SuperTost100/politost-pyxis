import { Check, CircleX } from "lucide-react";
import "./CheckBadge.css";

export function CheckBadge({
  state,
  reason,
  verifiedLabel,
  failedLabel,
  uncheckableLabel,
}: {
  state: "verified" | "failed" | "none";
  reason?: string;
  verifiedLabel: string;
  failedLabel: string;
  uncheckableLabel?: string;
}) {
  if (state === "none")
    return uncheckableLabel ? (
      <span className="px-check-badge is-uncheckable">{uncheckableLabel}</span>
    ) : null;
  if (state === "verified") {
    return (
      <span className="px-check-badge is-verified" title={verifiedLabel}>
        <Check size={16} strokeWidth={1.75} aria-hidden />
        <span>{verifiedLabel}</span>
      </span>
    );
  }
  return (
    <span className="px-check-badge is-failed" title={reason} tabIndex={0}>
      <CircleX size={16} strokeWidth={1.75} aria-hidden />
      <span>{failedLabel}</span>
    </span>
  );
}
