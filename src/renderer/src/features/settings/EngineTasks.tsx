import { useId } from "react";
import { useTranslation } from "react-i18next";
import { automaticEffort, studentEffort } from "@shared/effort";
import type { RequestOutput } from "@shared/ipc";
import { Button } from "../../components/Button";

/** In the order of the roles the tasks run in: the fast ones, the middle ones, the strong ones. */
export const featureNames = ["chat", "cards", "map", "lesson", "grading", "plan", "solve", "vision", "default"] as const;
export type Feature = (typeof featureNames)[number];
type Engine = RequestOutput<"engines.overview">[number];
type Model = RequestOutput<"engines.models">[number];
type Features = RequestOutput<"engines.features">;

const AUTO = "__auto__";
/**
 * Hard exercises go to the strong model of the tool answering the chat, so they have no model to pin: the field offers
 * Automatico and Spento, which means the chat never hands one on.
 */
const OFF = "__off__";
const followsChat = (feature: Feature) => feature === "solve";

/**
 * The model and the reasoning effort of each kind of work, for a student who wants to set them by hand. "Automatic"
 * leaves a kind of work to Pyxis, which follows the order of the tools and says which model that means today; a model
 * picked here pins the work to it and tints the field.
 */
export function EngineTasks({
  features,
  overview,
  modelsByProvider,
  choices,
  labelOf,
  autoLabel,
  roleOf,
  pinned,
  busy,
  customised,
  visionWarning,
  onModel,
  onEffort,
  onAutomatic,
  off,
  onOff,
}: {
  features: Features | undefined;
  overview: Engine[] | undefined;
  modelsByProvider: Record<string, Model[]>;
  /** The models a task can be pinned to, each named with its tool. */
  choices: Array<{ value: string; label: string; group: string }>;
  /** The name of a tool's model, for a pinned one the lists no longer hold. */
  labelOf: (provider: string, model: string) => string;
  /** The model as the field says it when automatic: "Haiku 5.5", with no maker's name the tool already gives. */
  autoLabel: (provider: string, model: string) => string;
  /** The role a task runs in on a tool, for the word under its name. */
  roleOf: (provider: string | undefined, feature: Feature) => "fast" | "mid" | "strong";
  /** How many kinds of work are pinned to a model. */
  pinned: number;
  busy: boolean;
  /** Something is pinned or an effort is picked, so going back to automatic changes something. */
  customised: boolean;
  visionWarning?: string | null;
  onModel: (feature: Feature, value: string, effort: string | undefined) => void;
  onEffort: (feature: Feature, effort: string | undefined) => void;
  /** Hands one task, or all of them when none is named, back to Pyxis. */
  onAutomatic: (feature?: Feature) => void;
  /** The tasks switched off, which may have no model row to show. */
  off: { solve: boolean } | undefined;
  /** Switches a task off (only hard exercises). "Automatic" switches it on again. */
  onOff: (feature: Feature) => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const levelLabel = (id: string) => t(`engines.effortLevel.${id}`, { defaultValue: id });
  const groups = [...new Set(choices.map((choice) => choice.group))];
  return (
    <section className="engines-section" aria-labelledby={headingId}>
      <div className="engines-heading">
        <h3 className="px-ctl-group-title" id={headingId}>
          {t("engines.perFeature")}
        </h3>
        {/* One state, one label: with something set by hand the count says it and the button undoes it; with nothing set
            there is only the statement and no control to press. */}
        <span className="small engines-hint" role="status">
          {pinned > 0
            ? t("engines.pinnedCount", { count: pinned })
            : customised
              ? t("engines.effortsPicked")
              : t("engines.allAuto")}
        </span>
      </div>
      <div className="engines-pinhead">
        <p className="small engines-hint">{t("engines.perFeatureHint")}</p>
        {customised ? (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => onAutomatic()}>
            {t("engines.backToAuto")}
          </Button>
        ) : null}
      </div>
      <div className="engines-feature-table">
        <div className="engines-feature-head small" aria-hidden="true">
          <span>{t("engines.taskHeading")}</span>
          <span>{t("engines.model")}</span>
          <span>{t("engines.effort")}</span>
        </div>
        {featureNames.map((feature) => {
          const selection = features?.[feature];
          const isOff = followsChat(feature) && off?.solve === true;
          const isAuto = !selection || selection.auto === true || followsChat(feature);
          const value = selection ? JSON.stringify([selection.provider, selection.model]) : "";
          const row = overview?.find((item) => item.id === selection?.provider);
          const listed = (
            modelsByProvider[selection?.provider ?? ""]?.find((item) => item.id === selection?.model)?.efforts ?? []
          ).filter(() => row?.capabilities.effort);
          const picked = studentEffort(selection);
          const pickedListed = listed.some((option) => option.id === picked);
          // The level Pyxis works out for an automatic task, which the model file sets per tool. With no pick of the
          // student's it is the level stored in the row.
          // shortcut: with a pick, the level shown is the tier's, which differs when the file sets another for this tool; upgrade by storing the automatic level in the row.
          const taskLevel =
            isAuto && !picked && selection?.effort && listed.some((option) => option.id === selection.effort)
              ? selection.effort
              : automaticEffort(
                  feature,
                  listed.map((option) => option.id),
                );
          // A pinned model the lists no longer hold stays in the picker, so the row shows what the task runs on.
          const missing = selection && !isAuto && !choices.some((choice) => choice.value === value);
          return (
            <div className="engines-feature-row" key={feature}>
              <div className="engines-feature-work">
                <label htmlFor={`engine-${feature}`}>{t(`engines.feature.${feature}`)}</label>
                {/* A pinned model runs whatever the student chose, not a role: the label says it is pinned. */}
                <small className="small">
                  {isAuto ? t(`engines.roles.${roleOf(selection?.provider, feature)}`) : t("engines.pinnedWork")}
                </small>
              </div>
              <div className="engines-feature-model">
                <select
                  id={`engine-${feature}`}
                  className={isAuto || isOff ? "px-ctl-field" : "px-ctl-field is-pinned"}
                  disabled={busy}
                  value={isOff ? OFF : isAuto ? AUTO : value}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (next === OFF) return onOff(feature);
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
                  <option value={AUTO}>
                    {isAuto && selection
                      ? t("engines.autoToday", { model: autoLabel(selection.provider, selection.model) })
                      : t("engines.automatic")}
                  </option>
                  {followsChat(feature) ? <option value={OFF}>{t("engines.off")}</option> : null}
                  {missing && !followsChat(feature) ? <option value={value}>{labelOf(selection.provider, selection.model)}</option> : null}
                  {followsChat(feature) ? null : groups.map((group) => (
                    <optgroup key={group} label={group}>
                      {choices
                        .filter((choice) => choice.group === group)
                        .map((choice) => (
                          <option key={choice.value} value={choice.value}>
                            {choice.label}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
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
                  disabled={!listed.length || busy || isOff}
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
      <p className="small engines-hint">{t("engines.solveAdvice")}</p>
    </section>
  );
}
