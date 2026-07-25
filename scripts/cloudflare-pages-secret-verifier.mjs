export const requiredPagesSecrets = Object.freeze([
  "CSRF_HMAC_SECRET",
  "OWNER_HASH_HMAC_SECRET",
  "R2_PARENT_ACCESS_KEY_ID",
  "R2_PARENT_SECRET_ACCESS_KEY",
]);

export function parseEncryptedPagesSecretNames(output) {
  if (typeof output !== "string") {
    throw new TypeError("Pages secret list output must be a string");
  }

  const names = new Set();
  const encryptedSecretPattern = /^\s*-\s+([A-Z][A-Z0-9_]*)\s*:\s+Value Encrypted\s*$/gmu;
  for (const match of output.matchAll(encryptedSecretPattern)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return names;
}

export function verifyRequiredPagesSecrets(output) {
  const encryptedSecretNames = parseEncryptedPagesSecretNames(output);
  const missing = requiredPagesSecrets.filter((name) => !encryptedSecretNames.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing required Pages secrets: ${missing.join(", ")}`);
  }

  return {
    listedCount: encryptedSecretNames.size,
    requiredCount: requiredPagesSecrets.length,
  };
}
