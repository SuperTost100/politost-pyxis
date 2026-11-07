import { App } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../lib/ipc";
import { textBase64 } from "../share/ExportButton";

export type MapExportFormat = "markdown" | "svg" | "pdf";

/**
 * Exports the whole saved map, whatever the screen shows: core writes the outline and draws the full-size SVG, and the
 * PDF prints both. `settle` waits for edits still on their way to core, so the file has the last drag.
 */
export function useMapExport(props: {
  planId: string;
  topicId: string;
  mapId?: string;
  settle: () => Promise<unknown>;
}) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);

  async function save(format: MapExportFormat) {
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

  return { busy, save };
}
