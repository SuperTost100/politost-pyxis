import { isInstallable } from "../../../shared/installers";

/** Engine names for an error read before the engine list has loaded. */
export const ENGINE_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  agent: "Cursor Agent",
  antigravity: "Antigravity",
  "anthropic-api": "Anthropic API",
  "openai-api": "OpenAI API",
  ollama: "Ollama",
};

export type EngineErrorView = {
  key: string;
  params: Record<string, string>;
  /** The CLI to sign in to again, when the error is its refused sign-in. */
  signIn?: string;
  /** The subscription refused the model: the student can pick another model or engine in Settings. */
  chooseModel?: boolean;
};

/**
 * What a screen says for an engine error. A refused sign-in names the engine and offers its sign-in, and a model the
 * subscription leaves out names the engine and offers a choice of another model, when the error says which engine it
 * was. Every other error keeps its own message.
 */
export function engineErrorView(
  key: string,
  provider: string | undefined,
  name?: string,
): EngineErrorView {
  if (key === "engines.errors.model-not-included" && provider)
    return {
      key: "engines.errors.modelNotIncludedNamed",
      params: { name: name ?? ENGINE_NAMES[provider] ?? provider },
      chooseModel: true,
    };
  if (key !== "engines.errors.not-logged-in" || !provider)
    return { key, params: {} };
  return {
    key: "engines.errors.signedOutNamed",
    params: { name: name ?? ENGINE_NAMES[provider] ?? provider },
    ...(isInstallable(provider) ? { signIn: provider } : {}),
  };
}

/** The `provider` an engine error carries in its params, if any. */
export function errorProvider(err: unknown): string | undefined {
  const params =
    err && typeof err === "object" && "params" in err
      ? (err as { params: unknown }).params
      : undefined;
  const provider =
    params && typeof params === "object" && "provider" in params
      ? (params as { provider: unknown }).provider
      : undefined;
  return typeof provider === "string" ? provider : undefined;
}
