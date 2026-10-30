import { isInstallable } from "../../../shared/installers";

/** Engine names for an error read before the engine list has loaded. */
const NAMES: Record<string, string> = {
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
};

/**
 * What a screen says for an engine error. A refused sign-in names the engine and offers its sign-in when the error says
 * which engine it was. Every other error keeps its own message.
 */
export function engineErrorView(
  key: string,
  provider: string | undefined,
  name?: string,
): EngineErrorView {
  if (key !== "engines.errors.not-logged-in" || !provider)
    return { key, params: {} };
  return {
    key: "engines.errors.signedOutNamed",
    params: { name: name ?? NAMES[provider] ?? provider },
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
