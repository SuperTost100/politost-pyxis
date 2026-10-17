import { Button, DatePicker, Input, TimePicker } from "antd";
import dayjs from "dayjs";
import dateIt from "antd/es/date-picker/locale/it_IT";
import dateEn from "antd/es/date-picker/locale/en_GB";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SESSION_LABEL_MAX, SESSION_PLACE_MAX } from "@shared/exam-sessions";
import { emptyDraft, MAX_EXAM_SESSIONS, type SessionDraft } from "./examSessions";
import "./ExamSessionsField.css";

/**
 * The exam sessions of a plan: a written part, an oral part. Each has a day, an optional time, an optional name
 * and an optional place. The first row is always there, so a plan with one exam looks the way it always did.
 * The wizard and the plan settings share it.
 */
export function ExamSessionsField({
  value,
  onChange,
  disabled = false,
  idPrefix,
  dateLabel,
}: {
  /** Never empty: the parent keeps one blank row, so a typed character always lands in a row that stays. */
  value: SessionDraft[];
  onChange: (next: SessionDraft[]) => void;
  disabled?: boolean;
  /** Keeps field IDs unique when the field appears twice in one document. */
  idPrefix: string;
  /** The first row's date label; later rows say "Session n". */
  dateLabel: string;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language.startsWith("it") ? dateIt : dateEn;
  const rows = value;
  const change = (key: string, patch: Partial<SessionDraft>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const last = rows[rows.length - 1]!;
  return (
    <div className="px-sessions">
      {rows.map((row, index) => {
        const id = `${idPrefix}-${row.key}`;
        const heading = t("sessions.heading", { n: index + 1 });
        return (
          <fieldset
            key={row.key}
            className="px-session"
            disabled={disabled}
            aria-label={rows.length > 1 ? heading : undefined}
          >
            {rows.length > 1 ? (
              <div className="px-session-head">
                <span className="label ink-muted" aria-hidden>
                  {heading}
                </span>
                <Button
                  type="text"
                  size="small"
                  shape="round"
                  icon={<X size={16} aria-hidden />}
                  aria-label={t("sessions.remove", { n: index + 1 })}
                  onClick={() => onChange(rows.filter((item) => item.key !== row.key))}
                >
                  {t("sessions.removeShort")}
                </Button>
              </div>
            ) : null}
            <div className="px-session-grid">
              <div className="px-form-field">
                <label className="label" htmlFor={`${id}-date`}>
                  {index === 0 ? dateLabel : t("sessions.date")}
                </label>
                <DatePicker
                  id={`${id}-date`}
                  value={row.date ? dayjs(row.date) : null}
                  locale={locale}
                  format="DD/MM/YYYY"
                  disabled={disabled}
                  disabledDate={(day) => day.startOf("day").isBefore(dayjs().startOf("day"))}
                  onChange={(day) => change(row.key, { date: day ? day.format("YYYY-MM-DD") : "" })}
                />
              </div>
              <div className="px-form-field">
                <label className="label" htmlFor={`${id}-time`}>
                  {t("sessions.time")}
                </label>
                <TimePicker
                  id={`${id}-time`}
                  value={row.time ? dayjs().hour(Number(row.time.slice(0, 2))).minute(Number(row.time.slice(3))) : null}
                  locale={locale}
                  format="HH:mm"
                  minuteStep={5}
                  showNow={false}
                  needConfirm={false}
                  disabled={disabled}
                  placeholder="--:--"
                  onChange={(time) => change(row.key, { time: time ? time.format("HH:mm") : "" })}
                />
              </div>
              <div className="px-form-field">
                <label className="label" htmlFor={`${id}-label`}>
                  {t("sessions.name")}
                </label>
                <Input
                  id={`${id}-label`}
                  value={row.label}
                  maxLength={SESSION_LABEL_MAX}
                  placeholder={t("sessions.namePlaceholder")}
                  disabled={disabled}
                  onChange={(event) => change(row.key, { label: event.target.value })}
                />
              </div>
              <div className="px-form-field">
                <label className="label" htmlFor={`${id}-place`}>
                  {t("sessions.place")}
                </label>
                <Input
                  id={`${id}-place`}
                  value={row.place}
                  maxLength={SESSION_PLACE_MAX}
                  placeholder={t("sessions.placePlaceholder")}
                  disabled={disabled}
                  onChange={(event) => change(row.key, { place: event.target.value })}
                />
              </div>
            </div>
          </fieldset>
        );
      })}
      <Button
        type="text"
        shape="round"
        className="px-session-add"
        icon={<Plus size={16} aria-hidden />}
        disabled={disabled || !last.date || rows.length >= MAX_EXAM_SESSIONS}
        onClick={() => onChange([...rows, emptyDraft()])}
      >
        {t("sessions.add")}
      </Button>
    </div>
  );
}
