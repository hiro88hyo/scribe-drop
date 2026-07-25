const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!BASE64URL_PATTERN.test(value)) {
    return undefined;
  }

  const remainder = value.length % 4;
  if (remainder === 1) {
    return undefined;
  }

  const paddingLength = remainder === 0 ? 0 : 4 - remainder;
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(paddingLength);

  try {
    const binary = atob(normalized);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}
