export const installableProviders = [
  "claude",
  "codex",
  "agent",
  "antigravity",
] as const;
export type InstallableProvider = (typeof installableProviders)[number];

type Installer = {
  /** The vendor's own install script for macOS and Linux, run with bash. */
  posix: string;
  /** The vendor's own PowerShell install script. */
  windows: string;
  /** The vendor's install page, for when the script cannot run here. */
  page: string;
};

/**
 * Each vendor's official installer. None needs Node, Homebrew or an administrator password: the program goes into the
 * student's home folder. Core runs these fixed URLs; the renderer only names a provider.
 */
export const installers: Record<InstallableProvider, Installer> = {
  claude: {
    posix: "https://claude.ai/install.sh",
    windows: "https://claude.ai/install.ps1",
    page: "https://code.claude.com/docs/en/setup",
  },
  codex: {
    posix: "https://chatgpt.com/codex/install.sh",
    windows: "https://chatgpt.com/codex/install.ps1",
    page: "https://developers.openai.com/codex/cli",
  },
  agent: {
    posix: "https://cursor.com/install",
    windows: "https://cursor.com/install?win32=true",
    page: "https://cursor.com/cli",
  },
  antigravity: {
    posix: "https://antigravity.google/cli/install.sh",
    windows: "https://antigravity.google/cli/install.ps1",
    page: "https://antigravity.google/cli",
  },
};

export function isInstallable(id: string): id is InstallableProvider {
  return (installableProviders as readonly string[]).includes(id);
}

/** The command a student would type for the same install. Setup shows it before Pyxis runs it. */
export function installCommand(
  provider: InstallableProvider,
  platform: string,
): string {
  return platform === "win32"
    ? `irm '${installers[provider].windows}' | iex`
    : `curl -fsSL '${installers[provider].posix}' | bash`;
}

/** The PoliTost page that lists free and student plans for each provider. */
export function offersPage(language: string): string {
  return language.startsWith("it")
    ? "https://politost.it/offerte"
    : "https://politost.it/en/offers";
}
