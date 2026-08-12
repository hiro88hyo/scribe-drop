import {
  buildCloudRunControllerSigningFrame,
  canonicalizeCloudRunControllerRequest,
  cloudRunControllerHeadersSchema,
  CLOUD_RUN_CONTROLLER_MAX_CLOCK_SKEW_MS,
  CLOUD_RUN_CONTROLLER_MAX_REQUEST_LIFETIME_MS,
  type CloudRunControllerSignedRequest,
} from "@scribe-drop/contracts";

import type { ControllerRequest } from "./contracts.js";

export interface ControllerClock {
  now(): Date;
}

export interface ControllerHmacKeys {
  get(keyId: "primary" | "secondary"): Promise<Uint8Array | null>;
}

export interface AuthenticateInput<
  TRequest extends CloudRunControllerSignedRequest = ControllerRequest,
> {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly keyId: string | null;
  readonly signature: string | null;
  readonly request: TRequest;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

const encoder = new TextEncoder();

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function sha256(value: string): Promise<string> {
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
  );
}

export async function buildControllerSignature(
  input: Pick<
    AuthenticateInput<CloudRunControllerSignedRequest>,
    "method" | "path" | "body" | "request"
  >,
  secret: Uint8Array,
): Promise<string> {
  const requestDigest = await digestControllerRequest(input.request);
  const secretCopy = new Uint8Array(secret.byteLength);
  secretCopy.set(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    secretCopy.buffer,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(buildCloudRunControllerSigningFrame({ ...input, requestDigest })),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

export async function digestControllerRequest(
  request: CloudRunControllerSignedRequest,
): Promise<string> {
  return sha256(canonicalizeCloudRunControllerRequest(request));
}

export async function authenticateControllerRequest<
  TRequest extends CloudRunControllerSignedRequest,
>(
  input: AuthenticateInput<TRequest>,
  clock: ControllerClock,
  keys: ControllerHmacKeys,
): Promise<"authenticated" | "expired" | "rejected"> {
  const parsedHeaders = cloudRunControllerHeadersSchema.safeParse({
    keyId: input.keyId,
    signature: input.signature,
  });
  if (!parsedHeaders.success) return "rejected";

  const issuedAt = Date.parse(input.request.issuedAt);
  const expiresAt = Date.parse(input.request.expiresAt);
  const now = clock.now().getTime();
  if (
    expiresAt < issuedAt ||
    expiresAt - issuedAt > CLOUD_RUN_CONTROLLER_MAX_REQUEST_LIFETIME_MS ||
    issuedAt > now + CLOUD_RUN_CONTROLLER_MAX_CLOCK_SKEW_MS ||
    expiresAt < now - CLOUD_RUN_CONTROLLER_MAX_CLOCK_SKEW_MS
  ) {
    return "expired";
  }

  const secret = await keys.get(parsedHeaders.data.keyId);
  if (secret === null || secret.byteLength < 32) return "rejected";
  const expected = await buildControllerSignature(input, secret);
  return constantTimeEqual(expected, parsedHeaders.data.signature) ? "authenticated" : "rejected";
}
