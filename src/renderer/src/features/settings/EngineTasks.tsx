import { useTranslation } from "react-i18next";
import { automaticEffort, studentEffort } from "@shared/effort";
import type { RequestOutput } from "@shared/ipc";
import { Button } from "../../components/Button";

export const featureNames = ["default", "chat", "plan", "lesson", "cards", "grading", "map", "vision"] as const;
export type Feature = (typeof featureNames)[number];
type Engine = RequestOutput<"engines.overview">[number];
type Model = RequestOutput<"engines.models">[number];
type Features = RequestOutput<"engines.features">;

const AUTO = "__auto__";

/**
 * The model and the reasoning effort of each task, for a student who wants to set them by hand. "Automatic" leaves a
 * task to Pyxis, which follows the order of the tools; a model picked here pins the task to it.
 */
export function EngineTasks({
  features,
  overview,
  modelsByProvider,
  choices,
  labelOf,
  busy,
  customised,
  visionWarning,
  onModel,
  onEffort,
  onAutomatic,
}: {
  features: Features | undefined;
  overview: Engine[] | undefined;
  modelsByProvider: Record<string, Model[]>;
  /** The models a task can be pinned to, each named with its tool. */
  choices: Array<{ value: string; label: string }>;
  /** The name of a tool's model, for a pinned one the lists no longer hold. */
  labelOf: (provider: string, model: string) => string;
  busy: boolean;
  /** Something is pinned or an effort is picked, so going back to automatic changes something. */
  customised: boolean;
  visionWarning?: string | null;
  onModel: (feature: Feature, value: string, effort: string | undefined) => void;
  onEffort: (feature: Feature, effort: string | undefined) => void;
  /** Hands one task, or all of them when none is named, back to Pyxis. */
  onAutomatic: (feature?: Feature) => void;
}) {
  const { t } = useTranslation();
  const levelLabel = (id: string) => t(`engines.effortLevel.${id}`, { defaultValue: id });
  return (
    <details className="engines-section">
      <summary>
        {t("engines.perFeature")}
      </summary>
      <div className="engines-heading">
        <span className="small ink-muted">{t("engines.perFeatureHint")}</span>
        <Button variant="secondary" size="sm" disabled={busy || !customised} onClick={() => onAutomatic()}>
          {t("engines.backToAuto")}
        </Button>
      </div>
      <div className="engines-feature-table">
        <div className="engines-feature-head small" aria-hidden="true">
          <span>{t("engines.taskHeading")}</span>
          <span>{t("engines.model")}</span>
          <span>{t("engines.effort")}</span>
        </div>
        {featureNames.map((feature) => {
          const selection = features?.[feature];
          const isAuto = !selection || selection.auto === true;
          const value = selection ? JSON.stringify([selection.provider, selection.model]) : "";
          const row = overview?.find((item) => item.id === selection?.provider);
          const listed = (
            modelsByProvider[selection?.provider ?? ""]?.find((item) => item.id === selection?.model)?.efforts ?? []
          ).filter(() => row?.capabilities.effort);
          const picked = studentEffort(selection);
          const pickedListed = listed.some((option) => option.id === picked);
          const taskLevel = automaticEffort(
            feature,
            listed.map((option) => option.id),
          );
          // A pinned model the lists no longer hold stays in the picker, so the row shows what the task runs on.
          const options =
            selection && !isAuto && !choices.some((choice) => choice.value === value)
              ? [{ value, label: labelOf(selection.provider, selection.model) }, ...choices]
              : choices;
          return (
            <div className="engines-feature-row" key={feature}>
              <label htmlFor={`engine-${feature}`}>{t(`engines.feature.${feature}`)}</label>
              <div className="engines-feature-model">
                <select
                  id={`engine-${feature}`}
                  className="px-ctl-field"
                  disabled={busy}
                  value={isAuto ? AUTO : value}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (next === AUTO) return onAutomatic(feature);
                    const [provider] = JSON.parse(next) as [string, string];
                    // The pick travels with the task and applies wherever the new model lists it.
                    onModel(
                      feature,
                      next,
                      overview?.find((item) => item.id === provider)?.capabilities.effort ? picked : undefined,
                    );
                  }}
                >
                  <option value={AUTO}>{t("engines.automatic")}</option>
                  {options.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
                {isAuto && selection ? (
                  <p className="small engines-auto-model">
                    {labelOf(selection.provider, selection.model)}
                    {selection.effort ? ` · ${levelLabel(selection.effort)}` : ""}
                  </p>
                ) : null}
                {feature === "vision" && visionWarning ? (
                  <p className="small engines-warning">{t(visionWarning)}</p>
                ) : null}
              </div>
              <div className="engines-feature-effort">
                <span className="small engines-effort-caption">{t("engines.effort")}</span>
                <select
                  id={`engine-effort-${feature}`}
                  className="px-ctl-field"
                  aria-label={`${t(`engines.feature.${feature}`)}: ${t("engines.effort")}`}
                  disabled={!listed.length || busy}
                  value={pickedListed ? picked : AUTO}
                  onChange={(event) =>
                    onEffort(feature, event.target.value === AUTO ? undefined : event.target.value)
                  }
                >
                  <option value={AUTO}>
                    {listed.length
                      ? taskLevel
                        ? t("engines.effortAuto", { level: levelLabel(taskLevel) })
                        : t("engines.automatic")
                      : t("engines.effortNone")}
                  </option>
                  {listed.map((option) => (
                    <option key={option.id} value={option.id}>
                      {levelLabel(option.id)}
                    </option>
                  ))}
                </select>
                {picked && listed.length && !pickedListed ? (
                  <p className="small engines-warning">{t("engines.effortFellBack", { level: levelLabel(picked) })}</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <p className="small engines-hint">{t("engines.modelAdvice")}</p>
      <p className="small engines-hint">{t("engines.effortAdvice")}</p>
    </details>
  );
}
