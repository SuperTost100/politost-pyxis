import { useQuery } from "@tanstack/react-query";
import { Button } from "antd";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlanFile } from "@shared/plan-file";
import { Notice } from "../../components/Notice";
import { invoke } from "../../lib/ipc";
import {
  defaultChoices,
  importRequest,
  locatedData,
  previewPlan,
  type ImportRequest,
  type SourceChoice,
} from "./importPreview";
import "./ImportReview.css";

const COUNTS = [
  "topics",
  "lessons",
  "quizzes",
  "cards",
  "maps",
  "exercises",
] as const;

function size(bytes: number): string {
  return bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Shows what a validated plan file holds and how each missing original is handled. Nothing is written until Import. */
export function ImportReview({
  file,
  onImport,
  onCancel,
}: {
  file: PlanFile;
  onImport: (request: ImportRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const library = useQuery({
    queryKey: ["sources"],
    queryFn: () => invoke("sources.list", {}),
  });
  const preview = useMemo(
    () => previewPlan(file, library.data ?? []),
    [file, library.data],
  );
  const [picked, setPicked] = useState<Record<number, SourceChoice>>({});
  const [located, setLocated] = useState<Record<number, string>>({});
  const [wrong, setWrong] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const locating = useRef<number | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const choices = { ...defaultChoices(preview), ...picked };
  // A choice that cannot work yet (file not verified, library copy gone) blocks the import instead of falling back.
  const unresolved = preview.missing.some(
    (source) =>
      (choices[source.index] === "file" && !located[source.index]) ||
      (choices[source.index] === "library" && !source.libraryId),
  );

  async function verify(index: number, chosen: Blob) {
    const source = file.sources?.[index];
    if (!source) return;
    const data = await locatedData(source, chosen).catch(() => null);
    setWrong(data ? null : index);
    setLocated((current) => {
      const next = { ...current };
      if (data) next[index] = data;
      else delete next[index];
      return next;
    });
  }

  async function submit() {
    if (pending.current || unresolved) return;
    pending.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await onImport(importRequest(file, preview, choices, located));
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const options: Array<{ value: SourceChoice; label: string }> = [
    { value: "library", label: t("shared.review.library") },
    { value: "file", label: t("shared.review.file") },
    { value: "excerpts", label: t("shared.review.excerpts") },
    { value: "skip", label: t("shared.review.skip") },
  ];

  return (
    <section className="px-import-review" aria-labelledby="import-review-title">
      <h2 id="import-review-title" className="title-2">
        {preview.title}
      </h2>
      {preview.author || preview.createdAt ? (
        <p className="small ink-muted">
          {[
            preview.author,
            preview.createdAt
              ? t("shared.review.created", {
                  date: new Date(preview.createdAt).toLocaleDateString(
                    i18n.language,
                  ),
                })
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      <p className="body-strong">{t("shared.review.contains")}</p>
      <ul className="px-import-counts">
        {COUNTS.filter((key) => preview.counts[key] > 0).map((key) => (
          <li key={key}>
            {t(`shared.review.counts.${key}`, { count: preview.counts[key] })}
          </li>
        ))}
        <li>
          {t(
            preview.progress
              ? "shared.review.progressYes"
              : "shared.review.progressNo",
          )}
        </li>
      </ul>
      {preview.generalTopics > 0 ? (
        <Notice tone="warning">{t("plans.draft")}</Notice>
      ) : null}
      {preview.sources.some((source) => source.embedded) ? (
        <>
          <p className="body-strong">{t("shared.review.embedded")}</p>
          <ul className="px-import-counts">
            {preview.sources
              .filter((source) => source.embedded)
              .map((source) => (
                <li key={source.index}>
                  {source.title} · {size(source.bytes)}
                </li>
              ))}
          </ul>
        </>
      ) : null}
      {preview.missing.length ? (
        <>
          <p className="body-strong">{t("shared.review.missing")}</p>
          <p className="small ink-muted">{t("shared.review.missingHelp")}</p>
          <p className="small ink-muted">{t("shared.review.skipHelp")}</p>
          <input
            ref={picker}
            type="file"
            hidden
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              event.target.value = "";
              const index = locating.current;
              if (chosen && index !== null) void verify(index, chosen);
            }}
          />
          {preview.missing.map((source) => (
            <fieldset key={source.index} className="px-import-source">
              <legend className="body-strong">{source.title}</legend>
              <p className="small ink-muted">
                {size(source.bytes)} ·{" "}
                {t("shared.review.excerptCount", { count: source.excerpts })}
              </p>
              {options.map((option) => {
                const off = option.value === "library" && !source.libraryId;
                return (
                  <label key={option.value} className="px-import-option">
                    <input
                      type="radio"
                      name={`source-${source.index}`}
                      checked={choices[source.index] === option.value}
                      disabled={off || busy}
                      onChange={() =>
                        setPicked((current) => ({
                          ...current,
                          [source.index]: option.value,
                        }))
                      }
                    />
                    <span>
                      {off ? t("shared.review.notInLibrary") : option.label}
                    </span>
                  </label>
                );
              })}
              {choices[source.index] === "file" ? (
                <div className="px-import-locate">
                  <Button
                    shape="round"
                    disabled={busy}
                    onClick={() => {
                      locating.current = source.index;
                      picker.current?.click();
                    }}
                  >
                    {t("shared.review.choose")}
                  </Button>
                  {located[source.index] ? (
                    <span className="small" role="status">
                      {t("shared.review.verified")}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {wrong === source.index ? (
                <Notice tone="warning">{t("shared.review.mismatch")}</Notice>
              ) : null}
            </fieldset>
          ))}
        </>
      ) : null}
      {failed ? (
        <Notice tone="danger">{t("shared.importFailed")}</Notice>
      ) : null}
      <div className="px-import-actions">
        <Button
          type="primary"
          shape="round"
          loading={busy}
          disabled={unresolved}
          onClick={() => void submit()}
        >
          {t("shared.review.import")}
        </Button>
        <Button type="text" shape="round" disabled={busy} onClick={onCancel}>
          {t("shared.review.cancel")}
        </Button>
      </div>
    </section>
  );
}
