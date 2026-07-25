import type { AllowedMediaType } from "@scribe-drop/contracts";

import { encodeBase64Url } from "../security/base64url.js";
import type { RandomBytes } from "../id/ulid.js";

const SOURCE_NONCE_BYTES = 16;

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

export function createPhaseTwoSourceKey(
  jobId: string,
  contentType: AllowedMediaType,
  randomBytes: RandomBytes = defaultRandomBytes,
): string {
  const nonceBytes = randomBytes(SOURCE_NONCE_BYTES);
  if (nonceBytes.byteLength !== SOURCE_NONCE_BYTES) {
    throw new Error("Source nonce generator returned an invalid byte count");
  }

  const nonce = encodeBase64Url(nonceBytes);
  return `incoming/pending/${jobId}/${nonce}/source.${sourceExtensions[contentType]}`;
}
