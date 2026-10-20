import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState } from "./ErrorState";

/** A failed load: says so and offers Try again, so a page never stays empty with no word about why. */
export function LoadError({
  children,
  onRetry,
  details,
}: {
  children?: ReactNode;
  onRetry: () => void;
  details?: string | null;
}) {
  const { t } = useTranslation();
  return (
    <ErrorState
      action={{ label: t("components.notice.retry"), onClick: onRetry }}
      details={details}
    >
      {children ?? t("components.notice.loadFailed")}
    </ErrorState>
  );
}
