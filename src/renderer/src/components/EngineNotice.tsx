import { useQueryClient } from "@tanstack/react-query";
import { Button, Modal } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { EngineProvider } from "@shared/ipc";
import { invoke } from "../lib/ipc";

const vendors: Record<EngineProvider, string> = {
  claude: "Anthropic",
  "anthropic-api": "Anthropic",
  codex: "OpenAI",
  "openai-api": "OpenAI",
  agent: "Cursor",
  antigravity: "Google",
};

/** An engine that is ready and whose notice has not been read yet. */
export type NoticeEngine = { id: string; name: string; acknowledged: boolean };

export function unacknowledged<
  T extends NoticeEngine & { installed: boolean; loggedIn: boolean },
>(rows: readonly T[] | undefined): T[] {
  return (rows ?? []).filter(
    (row) => row.installed && row.loggedIn && !row.acknowledged,
  );
}

/**
 * Records the acknowledgement for every listed engine in one call. The notice appears at setup, in Settings and once at
 * launch, never while a task runs, because a task cannot reach an engine that was not acknowledged.
 */
export function useAcknowledge(onDone: () => void) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function acknowledge(engines: readonly NoticeEngine[]) {
    if (busy || engines.length === 0) return;
    setBusy(true);
    setFailed(false);
    try {
      await invoke("engines.acknowledge", {
        providers: engines.map((engine) => engine.id as EngineProvider),
      });
      // The reload can take seconds while engines are probed; show the answer now and let the reload confirm it.
      const ids = new Set<string>(engines.map((engine) => engine.id));
      client.setQueryData<NoticeEngine[]>(["engines"], (rows) =>
        rows?.map((row) => (ids.has(row.id) ? { ...row, acknowledged: true } : row)),
      );
      for (const queryKey of [["engines"], ["engine-features"]])
        void client.invalidateQueries({ queryKey });
      onDone();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return { acknowledge, busy, failed };
}

/** One panel for all engines: what leaves the computer, and where each engine sends it. */
export function EngineNoticeBody({
  engines,
  failed,
}: {
  engines: readonly NoticeEngine[];
  failed?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <p className="body">{t("engines.notice.intro")}</p>
      <ul className="engine-notice-list">
        {engines.map((engine) => (
          <li key={engine.id}>
            {t("engines.notice.item", {
              name: engine.name,
              vendor: vendors[engine.id as EngineProvider] ?? engine.name,
            })}
          </li>
        ))}
      </ul>
      {failed ? <p role="alert">{t("engines.disclosureFailed")}</p> : null}
    </>
  );
}

/** The same notice as a card, for the setup step. */
export function EngineNoticePanel({
  engines,
  onDone,
}: {
  engines: readonly NoticeEngine[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { acknowledge, busy, failed } = useAcknowledge(onDone);
  return (
    <section className="px-card engine-notice" aria-label={t("engines.notice.title")}>
      <h2 className="engines-summary-title">{t("engines.notice.title")}</h2>
      <EngineNoticeBody engines={engines} failed={failed} />
      <Button
        type="primary"
        shape="round"
        loading={busy}
        onClick={() => void acknowledge(engines)}
      >
        {t("engines.acknowledge")}
      </Button>
    </section>
  );
}

/** The same notice as a dialog, for Settings and for the one check at launch. */
export function EngineNoticeModal({
  engines,
  onDone,
  onLater,
}: {
  engines: readonly NoticeEngine[];
  onDone: () => void;
  onLater: () => void;
}) {
  const { t } = useTranslation();
  const { acknowledge, busy, failed } = useAcknowledge(onDone);
  return (
    <Modal
      open={engines.length > 0}
      title={t("engines.notice.title")}
      maskClosable={false}
      keyboard={!busy}
      closable={false}
      okText={t("engines.acknowledge")}
      cancelText={t("engines.notice.later")}
      cancelButtonProps={{ disabled: busy }}
      confirmLoading={busy}
      onOk={() => void acknowledge(engines)}
      onCancel={() => {
        if (!busy) onLater();
      }}
    >
      <EngineNoticeBody engines={engines} failed={failed} />
    </Modal>
  );
}
