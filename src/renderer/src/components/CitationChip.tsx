import { Button } from "antd";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import "./CitationChip.css";

export function CitationChip({
  kind = "smartbook",
  children,
  onClick,
}: {
  kind?: "smartbook" | "pdf";
  children: ReactNode;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      type="text"
      className="px-cite"
      onClick={onClick}
      title={t("components.citation.open")}
    >
      <Icon
        name={kind === "pdf" ? "book-open" : "book-marked"}
        size={13}
        strokeWidth={2}
      />
      {children}
    </Button>
  );
}
