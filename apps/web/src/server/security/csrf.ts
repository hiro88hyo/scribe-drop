import { z } from "zod";

import { decodeBase64Url, encodeBase64Url } from "./base64url.js";

const CSRF_VERSION = "v1";
const CSRF_TTL_SECONDS = 15 * 60;
const CLOCK_TOLERANCE_SECONDS = 30;
const NONCE_BYTES = 16;
const HMAC_BYTES = 32;
const MAX_TOKEN_LENGTH = 4096;

const tokenSchema = z.string().min(1).max(MAX_TOKEN_LENGTH);
const integerTextSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);

export interface CsrfTokenOptions {
  readonly nowSeconds: number;
  readonly origin: string;
  readonly secret: string;
  readonly sub: string;
}

export interface IssueCsrfTokenOptions extends CsrfTokenOptions {
  readonly randomBytes?: (length: number) => Uint8Array;
}

function encodeLengthPrefixed(parts: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const encodedParts = parts.map((part) => encoder.encode(part));
  const totalLength = encodedParts.reduce((total, part) => total + 4 + part.byteLength, 0);
  const result = new Uint8Array(totalLength);
  const view = new DataView(result.buffer);
  let offset = 0;

  for (const part of encodedParts) {
    view.setUint32(offset, part.byteLength, false);
    offset += 4;
    result.set(part, offset);
    offset += part.byteLength;
  }

  return result;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function issueCsrfToken(options: IssueCsrfTokenOptions): Promise<string> {
  const issuedAt = Math.floor(options.nowSeconds);
  const expiresAt = issuedAt + CSRF_TTL_SECONDS;
  const nonce = encodeBase64Url((options.randomBytes ?? defaultRandomBytes)(NONCE_BYTES));
  const fields = [
    CSRF_VERSION,
    String(issuedAt),
    String(expiresAt),
    nonce,
    options.sub,
    options.origin,
  ] as const;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await importHmacKey(options.secret),
      encodeLengthPrefixed(fields),
    ),
  );

  return `${CSRF_VERSION}.${String(issuedAt)}.${String(expiresAt)}.${nonce}.${encodeBase64Url(signature)}`;
}

export async function verifyCsrfToken(token: string, options: CsrfTokenOptions): Promise<boolean> {
  const tokenResult = tokenSchema.safeParse(token);
  if (!tokenResult.success) {
    return false;
  }

  const fields = tokenResult.data.split(".");
  if (fields.length !== 5) {
    return false;
  }
  const [version, issuedAtText, expiresAtText, nonce, signatureText] = fields;
  if (
    version !== CSRF_VERSION ||
    issuedAtText === undefined ||
    expiresAtText === undefined ||
    nonce === undefined ||
    signatureText === undefined ||
    !integerTextSchema.safeParse(issuedAtText).success ||
    !integerTextSchema.safeParse(expiresAtText).success
  ) {
    return false;
  }

  const issuedAt = Number(issuedAtText);
  const expiresAt = Number(expiresAtText);
  const now = Math.floor(options.nowSeconds);
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > CSRF_TTL_SECONDS ||
    issuedAt > now + CLOCK_TOLERANCE_SECONDS ||
    expiresAt < now - CLOCK_TOLERANCE_SECONDS
  ) {
    return false;
  }

  const nonceBytes = decodeBase64Url(nonce);
  const signature = decodeBase64Url(signatureText);
  if (nonceBytes?.byteLength !== NONCE_BYTES || signature?.byteLength !== HMAC_BYTES) {
    return false;
  }

  return crypto.subtle.verify(
    "HMAC",
    await importHmacKey(options.secret),
    signature,
    encodeLengthPrefixed([
      version,
      issuedAtText,
      expiresAtText,
      nonce,
      options.sub,
      options.origin,
    ]),
  );
}
