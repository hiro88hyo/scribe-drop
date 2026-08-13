import {
  CLOUD_RUN_CONTROLLER_ATTEST_PATH,
  CLOUD_RUN_CONTROLLER_MAX_REQUEST_LIFETIME_MS,
  CLOUD_RUN_CONTROLLER_MUTATION_PATH,
  CLOUD_RUN_RUNTIME_POLICY,
  buildCloudRunControllerSigningFrame,
  canonicalizeCloudRunControllerRequest,
  cloudRunControllerAttestationRequestSchema,
  cloudRunControllerAttestationResponseSchema,
  cloudRunControllerRequestSchema,
  cloudRunControllerResponseSchema,
  cloudRunOpaqueHandleSchema,
  type CloudRunControllerAttestationResponse,
  type CloudRunControllerKeyId,
} from "@scribe-drop/contracts";

import type {
  ControllerExecutionAttestor,
  ControllerExecutionReadback,
  RuntimeCleanupScheduler,
  RuntimeClock,
  RuntimeIdGenerator,
} from "./cloud-run-runtime-service.js";

const MAX_CONTROLLER_RESPONSE_BYTES = 16 * 1024;
const CONTROLLER_TIMEOUT_MS = 10_000;
const encoder = new TextEncoder();

export interface CloudRunControllerClientConfiguration {
  readonly baseUrl: string;
  readonly environment: "staging" | "production";
  readonly keyId: CloudRunControllerKeyId;
  readonly requestLifetimeMs: number;
  readonly secret: Uint8Array;
}

export interface CloudRunControllerClientPorts {
  readonly clock: RuntimeClock;
  readonly fetch: typeof fetch;
  readonly ids: RuntimeIdGenerator;
}

function parseBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".local")
  ) {
    throw new Error("invalid Cloud Run controller base URL");
  }
  return url.toString();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export async function buildCloudRunControllerClientSignature(
  input: {
    readonly method: string;
    readonly path: string;
    readonly request: {
      readonly [key: string]: unknown;
      readonly expiresAt: string;
      readonly issuedAt: string;
      readonly requestId: string;
    };
  },
  secret: Uint8Array,
): Promise<string> {
  const requestDigest = encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(canonicalizeCloudRunControllerRequest(input.request)),
      ),
    ),
  );
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

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!/^application\/json(?:\s*;.*)?$/u.test(response.headers.get("content-type") ?? "")) {
    throw new Error("Cloud Run controller response was rejected");
  }
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > MAX_CONTROLLER_RESPONSE_BYTES)
  ) {
    throw new Error("Cloud Run controller response was rejected");
  }
  if (response.body === null) throw new Error("Cloud Run controller response was rejected");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result: unknown = await reader.read();
    if (!isRecord(result) || typeof result["done"] !== "boolean") {
      throw new Error("Cloud Run controller response was rejected");
    }
    if (result["done"]) break;
    const value = result["value"];
    if (!(value instanceof Uint8Array)) {
      throw new Error("Cloud Run controller response was rejected");
    }
    total += value.byteLength;
    if (total > MAX_CONTROLLER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Cloud Run controller response was rejected");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(combined),
    ) as unknown;
  } catch {
    throw new Error("Cloud Run controller response was rejected");
  }
}

export class CloudRunControllerClient
  implements ControllerExecutionAttestor, RuntimeCleanupScheduler
{
  readonly #baseUrl: string;
  readonly #environment: "staging" | "production";
  readonly #keyId: CloudRunControllerKeyId;
  readonly #ports: CloudRunControllerClientPorts;
  readonly #requestLifetimeMs: number;
  readonly #secret: Uint8Array;

  constructor(
    configuration: CloudRunControllerClientConfiguration,
    ports: CloudRunControllerClientPorts,
  ) {
    if (
      configuration.requestLifetimeMs <= 0 ||
      configuration.requestLifetimeMs > CLOUD_RUN_CONTROLLER_MAX_REQUEST_LIFETIME_MS ||
      configuration.secret.byteLength < 32
    ) {
      throw new Error("invalid Cloud Run controller client configuration");
    }
    this.#baseUrl = parseBaseUrl(configuration.baseUrl);
    this.#environment = configuration.environment;
    this.#keyId = configuration.keyId;
    this.#requestLifetimeMs = configuration.requestLifetimeMs;
    this.#secret = new Uint8Array(configuration.secret.byteLength);
    this.#secret.set(configuration.secret);
    this.#ports = ports;
  }

  async read(executionHandle: string): Promise<ControllerExecutionReadback | null> {
    const response = await this.#attest(executionHandle);
    if (response.outcome !== "found") return null;
    return {
      activeExecutionCount: response.attestation.activeExecutionCount,
      environment: response.attestation.environment,
      executionHandle: response.attestation.executionHandle,
      executionName: response.attestation.executionName,
      jobName: response.attestation.jobName,
      manifestMatches: response.attestation.manifestMatches,
      policyId: response.attestation.policyId,
      retriedCount: response.attestation.retriedCount,
      runtimeServiceAccount: response.attestation.runtimeServiceAccount,
      state: response.attestation.state,
      taskCount: response.attestation.taskCount,
    };
  }

  async schedule(input: {
    readonly environment: "staging" | "production";
    readonly executionHandle: string;
  }): Promise<void> {
    if (input.environment !== this.#environment) {
      throw new Error("Cloud Run controller environment mismatch");
    }
    const attestation = await this.#attest(input.executionHandle);
    if (attestation.outcome !== "found") {
      throw new Error("Cloud Run cleanup attestation failed");
    }
    const now = this.#ports.clock.now();
    const request = cloudRunControllerRequestSchema.parse({
      action: "cleanup",
      environment: this.#environment,
      executionHandle: input.executionHandle,
      expectedVersion: attestation.attestation.controllerVersion,
      expiresAt: new Date(now.getTime() + this.#requestLifetimeMs).toISOString(),
      issuedAt: now.toISOString(),
      policyId: CLOUD_RUN_RUNTIME_POLICY,
      requestId: this.#ports.ids.next(),
      schemaVersion: 1,
    });
    const response = cloudRunControllerResponseSchema.parse(
      await this.#post(CLOUD_RUN_CONTROLLER_MUTATION_PATH, request),
    );
    if (
      response.requestId !== request.requestId ||
      response.executionHandle !== request.executionHandle ||
      !["cleaned", "pending"].includes(response.outcome) ||
      response.errorCode !== null
    ) {
      throw new Error("Cloud Run cleanup request failed");
    }
  }

  async #attest(executionHandle: string): Promise<CloudRunControllerAttestationResponse> {
    const now = this.#ports.clock.now();
    const request = cloudRunControllerAttestationRequestSchema.parse({
      environment: this.#environment,
      executionHandle: cloudRunOpaqueHandleSchema.parse(executionHandle),
      expiresAt: new Date(now.getTime() + this.#requestLifetimeMs).toISOString(),
      issuedAt: now.toISOString(),
      policyId: CLOUD_RUN_RUNTIME_POLICY,
      requestId: this.#ports.ids.next(),
      schemaVersion: 1,
    });
    const response = cloudRunControllerAttestationResponseSchema.parse(
      await this.#post(CLOUD_RUN_CONTROLLER_ATTEST_PATH, request),
    );
    if (
      response.requestId !== request.requestId ||
      response.executionHandle !== request.executionHandle
    ) {
      throw new Error("Cloud Run controller response identity mismatch");
    }
    return response;
  }

  async #post(
    path: string,
    request: { readonly requestId: string; readonly issuedAt: string; readonly expiresAt: string },
  ): Promise<unknown> {
    const body = JSON.stringify(request);
    const signature = await buildCloudRunControllerClientSignature(
      { method: "POST", path, request },
      this.#secret,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, CONTROLLER_TIMEOUT_MS);
    const providerFetch = this.#ports.fetch;
    let response: Response;
    try {
      response = await providerFetch(new URL(path, this.#baseUrl), {
        body,
        headers: {
          "content-type": "application/json",
          "x-scribe-key-id": this.#keyId,
          "x-scribe-signature": signature,
        },
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new Error("Cloud Run controller request outcome is unknown");
    } finally {
      clearTimeout(timeout);
    }
    if (response.status !== 200) throw new Error("Cloud Run controller request failed");
    return readBoundedJson(response);
  }
}
