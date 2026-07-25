import type { AllowedMediaType } from "@scribe-drop/contracts";

import type { RandomBytes } from "../id/ulid.js";
import { encodeBase64Url } from "../security/base64url.js";

const OWNER_HASH_BYTES = 16;
const SOURCE_NONCE_BYTES = 16;
const OWNER_HASH_CONTEXT = "scribe-drop:owner-hash:v1\u0000";

const sourceExtensions = {
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/x-wav": "wav",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
} as const satisfies Readonly<Record<AllowedMediaType, string>>;

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function encodeHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createOwnerHash(ownerSub: string, hmacSecret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(hmacSecret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${OWNER_HASH_CONTEXT}${ownerSub}`)),
  );
  return encodeHex(digest.slice(0, OWNER_HASH_BYTES));
}

export async function createSourceKey(
  ownerSub: string,
  ownerHashHmacSecret: string,
  jobId: string,
  contentType: AllowedMediaType,
  randomBytes: RandomBytes = defaultRandomBytes,
): Promise<string> {
  const nonceBytes = randomBytes(SOURCE_NONCE_BYTES);
  if (nonceBytes.byteLength !== SOURCE_NONCE_BYTES) {
    throw new Error("Source nonce generator returned an invalid byte count");
  }

  const ownerHash = await createOwnerHash(ownerSub, ownerHashHmacSecret);
  const nonce = encodeBase64Url(nonceBytes);
  return `incoming/${ownerHash}/${jobId}/${nonce}/source.${sourceExtensions[contentType]}`;
}
