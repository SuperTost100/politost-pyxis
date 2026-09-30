import { invoke } from "./ipc";

/**
 * IPC stand-in for cli-funnel's FunnelClient.
 * The settings screen draws EngineRow itself. Hooks can call these methods
 * without opening a local HTTP port.
 */
export function createFunnelClient() {
  return {
    providers: () => invoke("engines.overview", {}),
    test: (provider: string, model?: string) =>
      invoke("engines.test", { provider, model }),
    features: () => invoke("engines.features", {}),
    setFeature: (feature: string, provider: string, model: string) =>
      invoke("engines.setFeature", {
        feature: feature as
          | "default"
          | "chat"
          | "plan"
          | "lesson"
          | "grading"
          | "map"
          | "vision",
        provider,
        model,
      }),
    login: (provider: string) => invoke("engines.login", { provider }),
    sendLoginCode: (provider: string, code: string) =>
      invoke("engines.sendCode", { provider, code }),
  };
}
