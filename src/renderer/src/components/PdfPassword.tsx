import { Input } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../lib/ipc";
import { Dialog } from "./Dialog";
import { Notice } from "./Notice";
import "./PdfPassword.css";

const messageKeyOf = (err: unknown): string =>
  err && typeof err === "object" && "messageKey" in err
    ? String((err as { messageKey: unknown }).messageKey)
    : "sources.importFailed";

/**
 * Asks for the password of a locked PDF whose import stopped, and runs that import again with it. The password lives
 * in this dialog's state until it is sent, and core uses it for one read without storing it.
 */
export function PdfPasswordDialog({
  target,
  onClose,
}: {
  /** The stopped import and the name of its file. */
  target: { jobId: string; title: string } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (!target || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("sources.unlockPdf", { jobId: target.jobId, password });
      onClose();
    } catch (err) {
      setError(messageKeyOf(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={target != null}
      width="md"
      title={t("sources.pdfPassword.title")}
      busy={busy}
      onClose={onClose}
      // The password is dropped once the dialog is gone, not while it shrinks away.
      onClosed={() => {
        setPassword("");
        setError(null);
      }}
      actions={[
        { label: t("sources.pdfPassword.submit"), disabled: !password, working: busy, onClick: () => void submit() },
      ]}
    >
      <form
        className="px-pdf-password-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="label" htmlFor="pdf-password">
          {t("sources.pdfPassword.label", { title: target?.title ?? "" })}
        </label>
        <Input.Password
          id="pdf-password"
          autoComplete="off"
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p className="small ink-muted">{t("sources.pdfPassword.hint")}</p>
        {error ? <Notice tone="danger">{t(error)}</Notice> : null}
      </form>
    </Dialog>
  );
}
