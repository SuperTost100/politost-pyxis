import { Switch } from "antd";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import "./CrashReportsSwitch.css";

/**
 * The crash-report choice as a labelled switch row. First setup and Settings > Privacy render this same component, so
 * both screens say the same true thing: today the switch only records a preference, and nothing is sent.
 */
export function CrashReportsSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="px-crash">
      <div className="px-card px-crash-row">
        <div className="px-crash-text">
          <label className="body-strong" htmlFor={id}>
            {t("settings.crashReports")}
          </label>
          <p className="small" id={`${id}-hint`}>
            {t(checked ? "settings.crashOn" : "settings.crashOff")}
          </p>
        </div>
        <Switch
          id={id}
          checked={checked}
          disabled={disabled}
          aria-describedby={`${id}-hint`}
          onChange={onChange}
        />
      </div>
      <p className="small px-crash-detail">{t("settings.crashContents")}</p>
    </div>
  );
}
