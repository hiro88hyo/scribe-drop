import type {
  CloudRunAckRequest,
  CloudRunBootstrapRequest,
  CloudRunBootstrapResponse,
  CloudRunClaimRequest,
  CloudRunClaimResponse,
  CloudRunHeartbeatRequest,
  CloudRunTerminalRequest,
} from "@scribe-drop/contracts";

import type {
  CloudRunRuntimeStore,
  RuntimeAttemptContext,
  RuntimeBootstrapRecord,
  RuntimeClaimCapabilities,
  RuntimeSessionEvent,
} from "./cloud-run-runtime-store.js";

const encoder = new TextEncoder();

export const CLOUD_RUN_RUNTIME_ERROR_CODES = [
  "AUTHENTICATION_FAILED",
  "BOOTSTRAP_CONFLICT",
  "CHALLENGE_EXPIRED",
  "CLAIM_CONFLICT",
  "EXECUTION_NOT_FOUND",
  "INVALID_SEQUENCE",
  "RESOURCE_DRIFT",
  "SESSION_EXPIRED",
  "SESSION_REJECTED",
] as const;

export type CloudRunRuntimeErrorCode = (typeof CLOUD_RUN_RUNTIME_ERROR_CODES)[number];

export class CloudRunRuntimeError extends Error {
  readonly code: CloudRunRuntimeErrorCode;

  constructor(code: CloudRunRuntimeErrorCode) {
    super(code);
    this.name = "CloudRunRuntimeError";
    this.code = code;
  }
}

export interface RuntimeClock {
  now(): Date;
}

export interface RuntimeIdGenerator {
  next(): string;
}

export interface VerifiedGoogleIdentity {
  readonly audience: string;
  readonly expiresAt: string;
  readonly issuedAt: string;
  readonly issuer: string;
  readonly serviceAccountEmail: string;
  readonly subjectId: string;
}

export interface GoogleIdentityVerifier {
  verify(token: string, audience: string): Promise<VerifiedGoogleIdentity>;
}

export interface ControllerExecutionReadback {
  readonly activeExecutionCount: number;
  readonly environment: "staging" | "production";
  readonly executionHandle: string;
  readonly executionName: string;
  readonly jobName: string;
  readonly manifestMatches: boolean;
  readonly policyId: string;
  readonly retriedCount: number;
  readonly runtimeServiceAccount: string;
  readonly state: string;
  readonly taskCount: number;
}

export interface ControllerExecutionAttestor {
  read(executionHandle: string): Promise<ControllerExecutionReadback | null>;
}

export interface RuntimeSecretDeriver {
  derive(label: "challenge" | "session", fields: readonly string[]): Promise<string>;
  hash(value: string): Promise<string>;
}

export interface RuntimeSignatureVerifier {
  verify(publicKey: string, message: Uint8Array, signature: string): Promise<boolean>;
}

export interface RuntimeCapabilityIssuer {
  issue(input: {
    readonly claimDigest: string;
    readonly context: RuntimeAttemptContext;
    readonly expiresAt: string;
  }): Promise<RuntimeClaimCapabilities>;
}

export interface RuntimeCleanupScheduler {
  schedule(input: {
    readonly environment: "staging" | "production";
    readonly executionHandle: string;
  }): Promise<void>;
}

export interface CloudRunRuntimeConfiguration {
  readonly challengeLifetimeMs: number;
  readonly clockSkewMs: number;
  readonly environment: "staging" | "production";
  readonly identityAudience: string;
  readonly identityIssuer: string;
  readonly runtimeServiceAccount: string;
  readonly sessionLifetimeMs: number;
}

export interface CloudRunRuntimeServicePorts {
  readonly attestor: ControllerExecutionAttestor;
  readonly capabilities: RuntimeCapabilityIssuer;
  readonly cleanup: RuntimeCleanupScheduler;
  readonly clock: RuntimeClock;
  readonly ids: RuntimeIdGenerator;
  readonly identity: GoogleIdentityVerifier;
  readonly secrets: RuntimeSecretDeriver;
  readonly signatures: RuntimeSignatureVerifier;
  readonly store: CloudRunRuntimeStore;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function encodeBase64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalize(value)));
  return encodeBase64Url(new Uint8Array(bytes));
}

function addMilliseconds(now: Date, milliseconds: number): string {
  return new Date(now.getTime() + milliseconds).toISOString();
}

/** Length framing avoids ambiguity between challenge identity fields. */
export function frameRuntimeChallenge(fields: readonly string[]): Uint8Array {
  return encoder.encode(
    fields.map((field) => `${String(encoder.encode(field).byteLength)}:${field}`).join(""),
  );
}

export class HmacRuntimeSecretDeriver implements RuntimeSecretDeriver {
  readonly #secret: Uint8Array;

  constructor(secret: Uint8Array) {
    if (secret.byteLength < 32)
      throw new Error("runtime derivation secret must be at least 32 bytes");
    this.#secret = secret.slice();
  }

  async derive(label: "challenge" | "session", fields: readonly string[]): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      this.#secret,
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      frameRuntimeChallenge(["scribe-drop-runtime-v1", label, ...fields]),
    );
    return encodeBase64Url(new Uint8Array(signature));
  }

  async hash(value: string): Promise<string> {
    return digest(value);
  }
}

export class WebCryptoEd25519Verifier implements RuntimeSignatureVerifier {
  async verify(publicKey: string, message: Uint8Array, signature: string): Promise<boolean> {
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        decodeBase64Url(publicKey),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      return await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        decodeBase64Url(signature),
        message,
      );
    } catch {
      return false;
    }
  }
}

function challengeFields(record: RuntimeBootstrapRecord, challenge: string): readonly string[] {
  return [
    "scribe-drop-cloud-run-claim-v1",
    challenge,
    record.challengeId,
    record.bootstrapRequestId,
    record.executionHandle,
    record.executionName,
    record.jobName,
  ];
}

export class CloudRunRuntimeService {
  readonly #configuration: CloudRunRuntimeConfiguration;
  readonly #ports: CloudRunRuntimeServicePorts;

  constructor(configuration: CloudRunRuntimeConfiguration, ports: CloudRunRuntimeServicePorts) {
    if (
      configuration.challengeLifetimeMs <= 0 ||
      configuration.sessionLifetimeMs <= 0 ||
      configuration.clockSkewMs < 0
    ) {
      throw new Error("runtime lifetimes must be positive");
    }
    this.#configuration = configuration;
    this.#ports = ports;
  }

  async bootstrap(request: CloudRunBootstrapRequest): Promise<CloudRunBootstrapResponse> {
    const now = this.#ports.clock.now();
    const requestDigest = await digest(request);
    const existing = await this.#ports.store.getBootstrap(request.bootstrapRequestId);
    if (existing !== null) {
      if (
        existing.requestDigest !== requestDigest ||
        existing.executionHandle !== request.executionHandle
      ) {
        throw new CloudRunRuntimeError("BOOTSTRAP_CONFLICT");
      }
      if (Date.parse(existing.challengeExpiresAt) <= now.getTime()) {
        throw new CloudRunRuntimeError("CHALLENGE_EXPIRED");
      }
      return this.#bootstrapResponse(existing);
    }

    const context = await this.#requireContext(request.executionHandle);
    this.#requireRuntimeIdentity(request, context);
    const identity = await this.#ports.identity.verify(
      request.identityToken,
      this.#configuration.identityAudience,
    );
    this.#requireGoogleIdentity(identity, now);
    await this.#requireReadback(request, context);

    const challengeId = this.#ports.ids.next();
    const challengeExpiresAt = addMilliseconds(now, this.#configuration.challengeLifetimeMs);
    const publicKeyDigest = await digest(request.publicKey);
    const challenge = await this.#ports.secrets.derive("challenge", [
      request.bootstrapRequestId,
      requestDigest,
      challengeId,
    ]);
    const record: RuntimeBootstrapRecord = {
      bootstrapRequestId: request.bootstrapRequestId,
      challengeExpiresAt,
      challengeHash: await this.#ports.secrets.hash(challenge),
      challengeId,
      claimDigest: null,
      executionHandle: request.executionHandle,
      executionName: request.executionName,
      jobName: request.jobName,
      lastSequence: -1,
      publicKey: request.publicKey,
      publicKeyDigest,
      requestDigest,
      revokedAt: null,
      sessionExpiresAt: null,
      sessionId: null,
      sessionIssuedAt: null,
      sessionTokenHash: null,
      terminalDigest: null,
    };
    const result = await this.#ports.store.beginBootstrap({
      context,
      now: now.toISOString(),
      record,
    });
    if (result.outcome === "conflict") throw new CloudRunRuntimeError("BOOTSTRAP_CONFLICT");
    if (result.outcome === "not_found") throw new CloudRunRuntimeError("EXECUTION_NOT_FOUND");
    return this.#bootstrapResponse(result.record);
  }

  async claim(request: CloudRunClaimRequest): Promise<CloudRunClaimResponse> {
    const now = this.#ports.clock.now();
    const record = await this.#ports.store.getBootstrap(request.bootstrapRequestId);
    if (record?.executionHandle !== request.executionHandle) {
      throw new CloudRunRuntimeError("EXECUTION_NOT_FOUND");
    }
    if (Date.parse(record.challengeExpiresAt) <= now.getTime() && record.claimDigest === null) {
      throw new CloudRunRuntimeError("CHALLENGE_EXPIRED");
    }
    const context = await this.#requireContext(request.executionHandle);
    this.#requireRuntimeIdentity(request, context);
    await this.#requireReadback(request, context);

    const challenge = await this.#ports.secrets.derive("challenge", [
      record.bootstrapRequestId,
      record.requestDigest,
      record.challengeId,
    ]);
    if ((await this.#ports.secrets.hash(challenge)) !== record.challengeHash) {
      throw new CloudRunRuntimeError("CLAIM_CONFLICT");
    }
    const signatureValid = await this.#ports.signatures.verify(
      record.publicKey,
      frameRuntimeChallenge(challengeFields(record, challenge)),
      request.signature,
    );
    if (!signatureValid) throw new CloudRunRuntimeError("AUTHENTICATION_FAILED");

    const claimDigest = await digest(request);
    const sessionIssuedAt = now.toISOString();
    const sessionExpiresAt = addMilliseconds(now, this.#configuration.sessionLifetimeMs);
    const sessionId = this.#ports.ids.next();
    const sessionToken = await this.#ports.secrets.derive("session", [
      request.bootstrapRequestId,
      claimDigest,
      sessionId,
    ]);
    const result = await this.#ports.store.consumeChallenge({
      bootstrapRequestId: request.bootstrapRequestId,
      challengeId: request.challengeId,
      claimDigest,
      executionHandle: request.executionHandle,
      now: sessionIssuedAt,
      sessionExpiresAt,
      sessionId,
      sessionIssuedAt,
      sessionTokenHash: await this.#ports.secrets.hash(sessionToken),
    });
    if (result.outcome === "expired") throw new CloudRunRuntimeError("CHALLENGE_EXPIRED");
    if (result.outcome === "not_found") throw new CloudRunRuntimeError("EXECUTION_NOT_FOUND");
    if (result.outcome === "conflict") throw new CloudRunRuntimeError("CLAIM_CONFLICT");

    const claimed = result.record;
    if (
      claimed.sessionId === null ||
      claimed.sessionExpiresAt === null ||
      claimed.claimDigest === null
    ) {
      throw new CloudRunRuntimeError("CLAIM_CONFLICT");
    }
    if (Date.parse(claimed.sessionExpiresAt) <= now.getTime()) {
      throw new CloudRunRuntimeError("SESSION_EXPIRED");
    }
    const replayToken = await this.#ports.secrets.derive("session", [
      claimed.bootstrapRequestId,
      claimed.claimDigest,
      claimed.sessionId,
    ]);
    const capabilities = await this.#ports.capabilities.issue({
      claimDigest: claimed.claimDigest,
      context,
      expiresAt: claimed.sessionExpiresAt,
    });
    return {
      attemptId: context.attemptId,
      jobId: context.jobId,
      options: context.options,
      results: capabilities.results,
      session: {
        expiresAt: claimed.sessionExpiresAt,
        sessionId: claimed.sessionId,
        token: replayToken,
      },
      source: capabilities.source,
    };
  }

  async acknowledge(request: CloudRunAckRequest): Promise<{ readonly acknowledged: true }> {
    await this.#applySessionEvent({ kind: "ack", request });
    return { acknowledged: true };
  }

  async heartbeat(
    request: CloudRunHeartbeatRequest,
  ): Promise<{ readonly cancelRequested: boolean }> {
    const result = await this.#applySessionEvent({ kind: "heartbeat", request });
    return { cancelRequested: result.cancelRequested };
  }

  async terminal(
    request: CloudRunTerminalRequest,
  ): Promise<{ readonly accepted: true; readonly cleanupPending: true }> {
    const applied = await this.#applySessionEvent({ kind: "terminal", request });
    await this.#ports.cleanup.schedule({
      environment: applied.context.environment,
      executionHandle: applied.context.executionHandle,
    });
    return { accepted: true, cleanupPending: true };
  }

  async #applySessionEvent(event: RuntimeSessionEvent): Promise<{
    readonly cancelRequested: boolean;
    readonly context: RuntimeAttemptContext;
  }> {
    const result = await this.#ports.store.applySessionEvent({
      digest: await digest(event.request),
      event,
      now: this.#ports.clock.now().toISOString(),
      tokenHash: await this.#ports.secrets.hash(event.request.sessionToken),
    });
    if (result.outcome === "conflict") throw new CloudRunRuntimeError("CLAIM_CONFLICT");
    if (result.outcome === "expired") throw new CloudRunRuntimeError("SESSION_EXPIRED");
    if (result.outcome === "rejected") throw new CloudRunRuntimeError("SESSION_REJECTED");
    if (result.outcome === "stale") throw new CloudRunRuntimeError("INVALID_SEQUENCE");
    return result;
  }

  async #bootstrapResponse(record: RuntimeBootstrapRecord): Promise<CloudRunBootstrapResponse> {
    const challenge = await this.#ports.secrets.derive("challenge", [
      record.bootstrapRequestId,
      record.requestDigest,
      record.challengeId,
    ]);
    if ((await this.#ports.secrets.hash(challenge)) !== record.challengeHash) {
      throw new CloudRunRuntimeError("BOOTSTRAP_CONFLICT");
    }
    return {
      challenge,
      challengeId: record.challengeId,
      expiresAt: record.challengeExpiresAt,
    };
  }

  async #requireContext(executionHandle: string): Promise<RuntimeAttemptContext> {
    const context = await this.#ports.store.getAttempt(executionHandle);
    if (context === null) throw new CloudRunRuntimeError("EXECUTION_NOT_FOUND");
    return context;
  }

  #requireRuntimeIdentity(
    request: Pick<
      CloudRunBootstrapRequest,
      "environment" | "executionHandle" | "policyId" | "taskAttempt" | "taskCount" | "taskIndex"
    >,
    context: RuntimeAttemptContext,
  ): void {
    if (
      request.environment !== this.#configuration.environment ||
      request.environment !== context.environment ||
      request.executionHandle !== context.executionHandle
    ) {
      throw new CloudRunRuntimeError("RESOURCE_DRIFT");
    }
  }

  #requireGoogleIdentity(identity: VerifiedGoogleIdentity, now: Date): void {
    if (
      identity.audience !== this.#configuration.identityAudience ||
      identity.issuer !== this.#configuration.identityIssuer ||
      identity.serviceAccountEmail !== this.#configuration.runtimeServiceAccount ||
      !/^\d{6,32}$/u.test(identity.subjectId) ||
      Date.parse(identity.expiresAt) <= now.getTime() ||
      Date.parse(identity.issuedAt) > now.getTime() + this.#configuration.clockSkewMs
    ) {
      throw new CloudRunRuntimeError("AUTHENTICATION_FAILED");
    }
  }

  async #requireReadback(
    request: Pick<
      CloudRunBootstrapRequest,
      "environment" | "executionHandle" | "executionName" | "jobName" | "policyId"
    >,
    context: RuntimeAttemptContext,
  ): Promise<void> {
    const readback = await this.#ports.attestor.read(request.executionHandle);
    if (
      readback?.activeExecutionCount !== 1 ||
      readback.environment !== context.environment ||
      readback.executionHandle !== request.executionHandle ||
      readback.executionName !== request.executionName ||
      readback.jobName !== request.jobName ||
      !readback.manifestMatches ||
      readback.policyId !== request.policyId ||
      readback.retriedCount !== 0 ||
      readback.runtimeServiceAccount !== this.#configuration.runtimeServiceAccount ||
      readback.state !== "running" ||
      readback.taskCount !== 1
    ) {
      throw new CloudRunRuntimeError("RESOURCE_DRIFT");
    }
  }
}
