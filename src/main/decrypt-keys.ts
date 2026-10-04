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
