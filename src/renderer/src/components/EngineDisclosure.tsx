import { Modal } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EngineProvider } from "@shared/ipc";
import { invoke, onBroadcast } from "../lib/ipc";

const vendors: Record<EngineProvider, string> = {
  claude: "Anthropic",
  "anthropic-api": "Anthropic",
  codex: "OpenAI",
  "openai-api": "OpenAI",
  agent: "Cursor",
  antigravity: "Google",
};

export function EngineDisclosure() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // Listen first, then fetch: a broadcast seen meanwhile is newer than the snapshot.
    const versions = new Map<string, number>();
    const add = (provider: string) =>
      setProviders((current) =>
        current.includes(provider) ? current : [...current, provider],
      );
    const off = onBroadcast("engine.disclosure", ({ provider, pending }) => {
      versions.set(provider, (versions.get(provider) ?? 0) + 1);
      if (pending) add(provider);
      else setProviders((current) => current.filter((v) => v !== provider));
    });
    let live = true;
    let replayId = 0;
    const replay = () => {
      const id = ++replayId,
        before = new Map(versions);
      void invoke("engines.disclosurePending", {})
        .then(({ providers: waiting }) => {
          if (!live || id !== replayId) return;
          setProviders((current) => [
            ...new Set([
              ...waiting.filter(
                (provider) => versions.get(provider) === before.get(provider),
              ),
              ...current.filter(
                (provider) => versions.get(provider) !== before.get(provider),
              ),
            ]),
          ]);
        })
        .catch(() => {});
    };
    const offPort = window.pyxis.onPort(replay);
    replay();
    return () => {
      live = false;
      off();
      offPort();
    };
  }, []);
  const provider = providers[0] as EngineProvider | undefined;
  return (
    <Modal
      open={Boolean(provider)}
      title={provider ? vendors[provider] : ""}
      closable={false}
      maskClosable={false}
      keyboard={false}
      cancelText={t("export.cancel")}
      cancelButtonProps={{ disabled: busy }}
      onCancel={async () => {
        if (!provider || busy) return;
        try {
          await invoke("engines.disclosureCancel", { provider });
          setProviders((current) =>
            current.filter((value) => value !== provider),
          );
        } catch {
          setFailed(true);
        }
      }}
      okText={t("engines.acknowledge")}
      confirmLoading={busy}
      onOk={async () => {
        if (!provider || busy) return;
        setBusy(true);
        setFailed(false);
        try {
          await invoke("engines.acknowledge", { provider });
          setProviders((current) =>
            current.filter((value) => value !== provider),
          );
        } catch {
          setFailed(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="body">{t("engines.disclosure")}</p>
      {failed ? <p role="alert">{t("engines.disclosureFailed")}</p> : null}
    </Modal>
  );
}
