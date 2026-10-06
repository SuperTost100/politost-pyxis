import { Button, Input, Modal } from "antd";
import { X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LibraryPanel } from "../home/LibraryPanel";

export type WizardSource = {
  id: string;
  title: string;
  kind: string;
  status: string;
};

/** Smartbooks first, then by title, so the books a student studies from lead the picker. */
const byKindThenTitle = (a: WizardSource, b: WizardSource) =>
  Number(b.kind === "smartbook") - Number(a.kind === "smartbook") ||
  a.title.localeCompare(b.title);

function SourceMeta({ source }: { source: WizardSource }) {
  const { t } = useTranslation();
  return (
    <span className="meta">
      {t(`sources.kind.${source.kind}`, { defaultValue: source.kind })} ·{" "}
      {t(`sources.status.${source.status}`, { defaultValue: source.status })}
    </span>
  );
}

/**
 * The material step. A plan starts with no sources. Whatever the student imports here goes in at once,
 * and the library picker pulls in sources that were added earlier.
 */
export function WizardSources({
  library,
  picked,
  onPick,
  onRemove,
  onGuided,
  blocked,
}: {
  library: WizardSource[];
  picked: string[];
  /** Adds ids to the plan. The caller skips any that are already in it. */
  onPick: (sourceIds: string[]) => void;
  onRemove: (sourceId: string) => void;
  onGuided: () => void;
  blocked: boolean;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const inPlan = picked
    .map((id) => library.find((source) => source.id === id))
    .filter((source): source is WizardSource => source != null);
  return (
    <>
      <p className="small ink-muted" role="status">
        {t("wizard.sourcesInPlan", { count: inPlan.length })}
      </p>
      {inPlan.length ? (
        <ul
          className="px-wizard-source-list"
          aria-label={t("wizard.sourcesListLabel")}
        >
          {inPlan.map((source) => (
            <li key={source.id} className="px-wizard-source-row">
              <span className="px-wizard-source-text">
                <span className="body-strong">{source.title}</span>
                <SourceMeta source={source} />
              </span>
              <Button
                type="text"
                shape="circle"
                aria-label={t("wizard.removeSource", { title: source.title })}
                icon={<X size={16} />}
                onClick={() => onRemove(source.id)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="px-wizard-material-actions">
        <Button
          type={inPlan.length ? "default" : "primary"}
          shape="round"
          onClick={() => setAdding(true)}
        >
          {t("exams.addSources")}
        </Button>
        <Button shape="round" onClick={() => setPicking(true)}>
          {t("wizard.fromLibrary")}
        </Button>
      </div>
      {inPlan.length === 0 ? (
        <p className="small">
          {t("wizard.noMaterial")}{" "}
          <Button type="link" size="small" onClick={onGuided}>
            {t("wizard.noMaterialLink")}
          </Button>
        </p>
      ) : null}
      {blocked ? (
        <p className="small" role="alert">
          {t("wizard.sourceNotReady")}
        </p>
      ) : null}
      {adding ? (
        <LibraryPanel
          importOnly
          onClose={() => setAdding(false)}
          onImported={onPick}
        />
      ) : null}
      <LibraryPicker
        open={picking}
        library={library}
        picked={picked}
        onClose={() => setPicking(false)}
        onAdd={(ids) => {
          onPick(ids);
          setPicking(false);
        }}
      />
    </>
  );
}

/** Library sources that are not in the plan yet, with a search box. Nothing is added until the student confirms. */
function LibraryPicker({
  open,
  library,
  picked,
  onClose,
  onAdd,
}: {
  open: boolean;
  library: WizardSource[];
  picked: string[];
  onClose: () => void;
  onAdd: (sourceIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const free = library.filter((source) => !picked.includes(source.id));
  const needle = query.trim().toLocaleLowerCase();
  const shown = free
    .filter((source) => source.title.toLocaleLowerCase().includes(needle))
    .sort(byKindThenTitle);
  const count = chosen.filter((id) => free.some((s) => s.id === id)).length;
  const reset = () => {
    setQuery("");
    setChosen([]);
  };
  return (
    <Modal
      open={open}
      width={560}
      title={t("wizard.pickerTitle")}
      className="px-wizard-picker"
      onCancel={() => {
        reset();
        onClose();
      }}
      afterClose={reset}
      footer={null}
    >
      <Input
        allowClear
        value={query}
        aria-label={t("wizard.pickerSearch")}
        placeholder={t("wizard.pickerSearch")}
        onChange={(event) => setQuery(event.target.value)}
      />
      {shown.length ? (
        <ul className="px-wizard-source-list px-wizard-picker-list">
          {shown.map((source) => (
            <li key={source.id}>
              <label className="px-wizard-source-row is-pickable">
                <input
                  type="checkbox"
                  checked={chosen.includes(source.id)}
                  onChange={(event) =>
                    setChosen((current) =>
                      event.target.checked
                        ? [...current, source.id]
                        : current.filter((id) => id !== source.id),
                    )
                  }
                />
                <span className="px-wizard-source-text">
                  <span className="body-strong">{source.title}</span>
                  <SourceMeta source={source} />
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small ink-muted" role="status">
          {t(
            library.length === 0
              ? "wizard.pickerLibraryEmpty"
              : free.length === 0
                ? "wizard.pickerEmpty"
                : "wizard.pickerNoMatch",
          )}
        </p>
      )}
      <div className="px-wizard-picker-actions">
        <Button
          type="primary"
          shape="round"
          disabled={count === 0}
          onClick={() => {
            const ids = chosen.filter((id) => free.some((s) => s.id === id));
            reset();
            onAdd(ids);
          }}
        >
          {t("wizard.pickerAdd", { count })}
        </Button>
      </div>
    </Modal>
  );
}
