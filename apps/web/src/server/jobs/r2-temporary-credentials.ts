import {
  temporaryUploadCredentialsSchema,
  type TemporaryUploadCredentials,
} from "@scribe-drop/contracts";
import { SignJWT } from "jose";

export const UPLOAD_CREDENTIAL_TTL_SECONDS = 15 * 60;

const MULTIPART_UPLOAD_ACTIONS = [
  "CreateMultipartUpload",
  "UploadPart",
  "CompleteMultipartUpload",
  "AbortMultipartUpload",
] as const;

export interface R2TemporaryCredentialInput {
  readonly accountId: string;
  readonly bucket: string;
  readonly key: string;
  readonly now: Date;
  readonly parentAccessKeyId: string;
  readonly parentSecretAccessKey: string;
}

function encodeHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createR2TemporaryUploadCredentials(
  input: R2TemporaryCredentialInput,
): Promise<TemporaryUploadCredentials> {
  const issuedAtSeconds = Math.floor(input.now.getTime() / 1000);
  const expiresAtSeconds = issuedAtSeconds + UPLOAD_CREDENTIAL_TTL_SECONDS;
  const endpoint = `https://${input.accountId}.r2.cloudflarestorage.com`;
  const audience = new URL(endpoint).host;

  const jwt = await new SignJWT({
    actions: MULTIPART_UPLOAD_ACTIONS,
    bucket: input.bucket,
    paths: {
      objectPaths: [input.key],
      prefixPaths: [],
    },
    scope: "object-read-write",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(input.accountId)
    .setIssuer(input.parentAccessKeyId)
    .setAudience(audience)
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(expiresAtSeconds)
    .sign(new TextEncoder().encode(input.parentSecretAccessKey));

  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(jwt)),
  );

  return temporaryUploadCredentialsSchema.parse({
    accessKeyId: input.parentAccessKeyId,
    bucket: input.bucket,
    endpoint,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    key: input.key,
    region: "auto",
    secretAccessKey: encodeHex(digest),
    sessionToken: btoa(`jwt/${jwt}`),
  });
}
