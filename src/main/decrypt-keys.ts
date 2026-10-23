/** One damaged or foreign-user ciphertext must not block the other provider or startup. */
export function decryptKeys(
  stored: Record<string, unknown>,
  decrypt: (cipher: Buffer) => string,
): { anthropic?: string; openai?: string } {
  const keys: { anthropic?: string; openai?: string } = {};
  for (const provider of ["anthropic", "openai"] as const) {
    const value = stored[provider];
    if (typeof value !== "string" || !value) continue;
    try {
      keys[provider] = decrypt(Buffer.from(value, "base64"));
    } catch {
      // Keep the stored ciphertext so the owner can replace/remove it in Settings.
    }
  }
  return keys;
}

type KeyStorage = {
  isEncryptionAvailable(): boolean;
  decryptString(cipher: Buffer): string;
};

/**
 * The saved API keys, read from the OS store only when one is saved. On macOS both storage calls read the Keychain,
 * which asks for the login password when it doesn't trust this build; most students never save a key.
 */
export function readStoredKeys(
  stored: Record<string, unknown>,
  storage: KeyStorage,
): { anthropic?: string; openai?: string } {
  return decryptKeys(stored, (cipher) => {
    if (!storage.isEncryptionAvailable())
      throw new Error("encryption-unavailable");
    return storage.decryptString(cipher);
  });
}

/** Whether Settings offers the key form. macOS always has a Keychain, so asking it would only bring up the prompt. */
export function canSaveKeys(
  platform: NodeJS.Platform,
  isEncryptionAvailable: () => boolean,
  linuxBackend?: string,
): boolean {
  if (platform === "darwin") return true;
  return (
    isEncryptionAvailable() &&
    (platform !== "linux" || linuxBackend !== "basic_text")
  );
}
