import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { RequestOutput } from "@shared/ipc";
import { engineErrorView } from "./engineErrorView";
import { enginesQuery } from "./queries";

export { errorProvider } from "./engineErrorView";

/**
 * The text of an engine error and, for a refused sign-in, a "Sign in to …" action that opens that engine's sign-in in
 * Settings › AI engines. A model the subscription refused gets "Choose another model", which opens that page. `params` are the message's own values for every other error. A popover passes `go`, its own
 * way to leave, so it closes before the page changes.
 */
export function useEngineError(go?: (to: string) => void) {
  const { t } = useTranslation();
  // Dialogs such as Make cards render outside the router, so the default way there is the hash the router follows.
  const navigate =
    go ??
    ((to: string) => {
      window.location.hash = to;
    });
  const client = useQueryClient();
  return (
    key: string,
    provider?: string,
    params: Record<string, unknown> = {},
  ): { text: string; action?: { label: string; onClick: () => void } } => {
    const rows = client.getQueryData<RequestOutput<"engines.overview">>(
      enginesQuery.queryKey,
    );
    const name = rows?.find((row) => row.id === provider)?.name;
    const view = engineErrorView(key, provider, name);
    const text = t(view.key, { ...params, ...view.params });
    if (view.chooseModel)
      return {
        text,
        action: {
          label: t("engines.chooseModel"),
          onClick: () => navigate("/settings/engines"),
        },
      };
    if (!view.signIn) return { text };
    return {
      text,
      action: {
        label: t("engines.signInTo", { name: view.params.name }),
        onClick: () => navigate(`/settings/engines?signIn=${view.signIn}`),
      },
    };
  };
}
