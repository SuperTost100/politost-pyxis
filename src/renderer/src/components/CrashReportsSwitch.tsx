import { Switch } from "antd";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import "./CrashReportsSwitch.css";

/**
 * The crash-report choice as a labelled switch row. First setup and Settings > Privacy render this same component, so
 * both screens say the same thing: why the reports matter, what one holds and never holds, and how long it is kept.
 * The copy must match what src/main/crash-reports.ts and crash-worker/ really send and keep. In setup, the last line
 * says where to change the choice later; on the Privacy page the switch is that place.
 */
export function CrashReportsSwitch({
  checked,
  disabled,
  setup = false,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  /** First setup: the last line points to Settings, Privacy. */
  setup?: boolean;
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
          aria-describedby={`${id}-hint ${id}-why ${id}-facts`}
          onChange={onChange}
        />
      </div>
      <p className="small px-crash-detail" id={`${id}-why`}>
        {t("settings.crashWhy")}
      </p>
      <ul className="small px-crash-detail px-crash-facts" id={`${id}-facts`}>
        <li>{t("settings.crashContents")}</li>
        <li>{t("settings.crashNever")}</li>
        <li>{t(setup ? "settings.crashKeptSetup" : "settings.crashKept")}</li>
      </ul>
    </div>
  );
}
