import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";

import {
  UPLOAD_CREDENTIAL_TTL_SECONDS,
  createR2TemporaryUploadCredentials,
} from "../src/server/jobs/r2-temporary-credentials.js";

const NOW = new Date("2027-01-01T00:10:00.987Z");
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const ACCESS_KEY_ID = "test-parent-access-key";
const SECRET_ACCESS_KEY = "test-parent-secret-access-key-at-least-32-bytes";
const BUCKET = "recording-transcriber-test";
const KEY = "incoming/0123456789abcdef0123456789abcdef/01JGFJJZ00G40R40M30E209185/nonce/source.m4a";

function decodeSessionJwt(sessionToken: string): string {
  const decoded = atob(sessionToken);
  if (!decoded.startsWith("jwt/")) {
    throw new Error("Session token did not contain an R2 JWT");
  }
  return decoded.slice(4);
}

function encodeHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("R2 temporary upload credentials", () => {
  it("signs a 15 minute exact-object multipart-only capability", async () => {
    const credentials = await createR2TemporaryUploadCredentials({
      accountId: ACCOUNT_ID,
      bucket: BUCKET,
      key: KEY,
      now: NOW,
      parentAccessKeyId: ACCESS_KEY_ID,
      parentSecretAccessKey: SECRET_ACCESS_KEY,
    });

    expect(credentials).toMatchObject({
      accessKeyId: ACCESS_KEY_ID,
      bucket: BUCKET,
      endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      expiresAt: "2027-01-01T00:25:00.000Z",
      key: KEY,
      region: "auto",
    });

    const jwt = decodeSessionJwt(credentials.sessionToken);
    const verified = await jwtVerify(jwt, new TextEncoder().encode(SECRET_ACCESS_KEY), {
      audience: `${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      issuer: ACCESS_KEY_ID,
      subject: ACCOUNT_ID,
    });
    expect(verified.payload).toMatchObject({
      actions: [
        "CreateMultipartUpload",
        "UploadPart",
        "CompleteMultipartUpload",
        "AbortMultipartUpload",
      ],
      bucket: BUCKET,
      exp: Math.floor(NOW.getTime() / 1000) + UPLOAD_CREDENTIAL_TTL_SECONDS,
      iat: Math.floor(NOW.getTime() / 1000),
      paths: {
        objectPaths: [KEY],
        prefixPaths: [],
      },
    });
    expect(verified.payload).not.toHaveProperty("scope");
    expect(verified.payload).not.toHaveProperty("GetObject");

    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(jwt)),
    );
    expect(credentials.secretAccessKey).toBe(encodeHex(digest));
  });
});
