import { Button, Input } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FocusLayout } from "../../app/layouts/TaskLayouts";
import { invoke } from "../../lib/ipc";

export function PythonPage() {
  const { t } = useTranslation();
  const [code, setCode] = useState("print(1 + 1)");
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <FocusLayout title={t("python.title")}>
      <Input.TextArea
        aria-label={t("python.title")}
        value={code}
        rows={8}
        onChange={(event) => setCode(event.target.value)}
      />
      <Button
        type="primary"
        shape="round"
        loading={busy}
        onClick={() => {
          setBusy(true);
          void invoke("tools.python", { code })
            .then((result) => {
              if (result.timedOut) setOut(t("python.timeout"));
              else if (result.stderr === "python-missing" || result.stderr === "python-sandbox-missing") {
                setOut(t("python.missing"));
              } else setOut(result.stdout || result.stderr);
            })
            .catch(() => setOut(t("python.missing")))
            .finally(() => setBusy(false));
        }}
      >
        {t("python.run")}
      </Button>
      <pre className="small">{out}</pre>
    </FocusLayout>
  );
}
