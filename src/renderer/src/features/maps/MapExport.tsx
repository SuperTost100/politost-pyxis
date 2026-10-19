import { App, Button, Dropdown } from "antd";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../lib/ipc";
import { textBase64 } from "../share/ExportButton";

type Format = "markdown" | "svg" | "pdf";

/**
 * Exports the whole saved map, whatever the screen shows: core writes the outline and draws the full-size SVG, and the
 * PDF prints both. `settle` waits for edits still on their way to core, so the file has the last drag.
 */
export function MapExport(props: {
  planId: string;
  topicId: string;
  mapId?: string;
  disabled: boolean;
  settle: () => Promise<unknown>;
}) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);

  async function save(format: Format) {
    if (busy) return;
    setBusy(true);
    const key = "map-export";
    void message.open({
      key,
      type: "loading",
      content: t("map.exporting"),
      duration: 0,
    });
    try {
      await props.settle();
      const file = await invoke("maps.export", {
        planId: props.planId,
        topicId: props.topicId,
        mapId: props.mapId,
        language: i18n.language === "en" ? "en" : "it",
      });
      const result =
        format === "pdf"
          ? await window.pyxis.exportPdf({
              filename: file.filename.replace(/\.md$/i, ".pdf"),
              markdown: file.markdown,
              svg: file.svg,
            })
          : await window.pyxis.saveArtifact(
              format === "svg"
                ? {
                    filename: file.filename.replace(/\.md$/i, ".svg"),
                    base64: textBase64(file.svg),
                  }
                : {
                    filename: file.filename,
                    base64: textBase64(file.markdown),
                  },
            );
      if (result === "saved")
        void message.success({ key, content: t("export.saved") });
      else message.destroy(key);
    } catch {
      void message.error({ key, content: t("export.failed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dropdown
      trigger={["click"]}
      disabled={props.disabled || busy}
      // The menu opens outside the page's landmarks; a named region keeps it in one.
      popupRender={(menu) => (
        <div role="region" aria-label={t("map.export")}>
          {menu}
        </div>
      )}
      menu={{
        items: [
          { key: "markdown", label: t("map.exportMarkdown") },
          { key: "svg", label: t("map.exportSvg") },
          { key: "pdf", label: t("map.exportPdf") },
        ],
        onClick: ({ key }) => void save(key as Format),
      }}
    >
      <Button
        shape="round"
        disabled={props.disabled || busy}
        aria-haspopup="menu"
      >
        <span className="px-map-export">
          {t("map.export")}
          <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
        </span>
      </Button>
    </Dropdown>
  );
}
