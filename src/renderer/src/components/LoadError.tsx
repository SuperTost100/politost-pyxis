import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Notice } from "./Notice";

/** A failed load: says so and offers Try again, so a page never stays empty with no word about why. */
export function LoadError({
  children,
  onRetry,
}: {
  children?: ReactNode;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Notice
      tone="danger"
      action={{ label: t("components.notice.retry"), onClick: onRetry }}
    >
      {children ?? t("components.notice.loadFailed")}
    </Notice>
  );
}
