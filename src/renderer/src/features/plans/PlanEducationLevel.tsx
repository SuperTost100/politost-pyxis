import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Select } from "antd";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../lib/ipc";

const levels = [
  "primary",
  "lower-secondary",
  "upper-secondary",
  "technical",
  "vocational",
  "university",
  "other",
] as const;

/** ASK-09: the education level the tutor uses for this plan. Meant for the plan settings dialog. */
export function PlanEducationLevel({
  planId,
  disabled,
}: {
  planId: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const id = useId();
  const [failed, setFailed] = useState(false);
  const level = useQuery({
    queryKey: ["plan-education", planId],
    queryFn: () => invoke("plans.education", { planId }),
  });
  async function change(next: (typeof levels)[number]) {
    setFailed(false);
    try {
      const saved = await invoke("plans.setEducation", { planId, level: next });
      client.setQueryData(["plan-education", planId], saved);
    } catch {
      setFailed(true);
    }
  }
  return (
    <div className="px-plan-education">
      <label htmlFor={id} className="small">
        <strong>{t("planOverview.educationLevel")}</strong>
      </label>
      <Select
        id={id}
        value={level.data?.level ?? undefined}
        loading={level.isPending}
        disabled={disabled || !level.data?.level}
        options={levels.map((item) => ({
          value: item,
          label: t(`onboarding.levels.${item}`),
        }))}
        onChange={(next) => void change(next)}
        style={{ width: "100%" }}
      />
      <p className="small ink-muted" role={failed ? "alert" : undefined}>
        {t(failed ? "planOverview.educationFailed" : "planOverview.educationHelp")}
      </p>
    </div>
  );
}
