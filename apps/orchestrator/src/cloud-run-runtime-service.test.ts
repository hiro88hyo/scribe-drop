import { describe, expect, it } from "vitest";

import type {
  CloudRunBootstrapRequest,
  CloudRunClaimRequest,
  CloudRunTerminalRequest,
} from "@scribe-drop/contracts";

import {
  CloudRunRuntimeError,
  CloudRunRuntimeService,
  HmacRuntimeSecretDeriver,
  WebCryptoEd25519Verifier,
  frameRuntimeChallenge,
  type CloudRunRuntimeConfiguration,
  type CloudRunRuntimeServicePorts,
  type ControllerExecutionReadback,
  type VerifiedGoogleIdentity,
} from "./cloud-run-runtime-service.js";
import {
  InMemoryCloudRunRuntimeStore,
  type RuntimeAttemptContext,
} from "./cloud-run-runtime-store.js";

const HANDLE = "hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh";
const BOOTSTRAP_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const CHALLENGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const TOKEN =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.cccccccccccccccccccccccccccccccccccccccc";

function base64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function keyPair(): Promise<{
  readonly privateKey: CryptoKey;
  readonly publicKey: string;
}> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  return { privateKey: pair.privateKey, publicKey: base64Url(new Uint8Array(raw)) };
}

async function sign(privateKey: CryptoKey, fields: readonly string[]): Promise<string> {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, privateKey, frameRuntimeChallenge(fields)),
    ),
  );
}

const context: RuntimeAttemptContext = {
  attemptId: ATTEMPT_ID,
  cancelRequested: false,
  environment: "staging",
  executionHandle: HANDLE,
  jobId: JOB_ID,
  options: {
    contractVersion: 2,
    language: "ja",
    model: "large-v3-turbo",
    outputFormats: ["markdown", "json"],
    vad: false,
  },
  ownerHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sourceEtag: "dummy-etag",
  sourceKey: "sources/dummy.wav",
  sourceSizeBytes: 100,
  status: "PENDING_BOOTSTRAP",
};

const configuration: CloudRunRuntimeConfiguration = {
  challengeLifetimeMs: 5 * 60 * 1_000,
  clockSkewMs: 30_000,
  environment: "staging",
  identityAudience: "https://orchestrator.example.invalid/internal/cloud-run/bootstrap",
  identityIssuer: "https://accounts.google.com",
  runtimeServiceAccount: "runtime@dummy-project.iam.gserviceaccount.com",
  sessionLifetimeMs: 55 * 60 * 1_000,
};

const readback: ControllerExecutionReadback = {
  activeExecutionCount: 1,
  environment: "staging",
  executionHandle: HANDLE,
  executionName: "sd-stg-execution-1",
  jobName: "sd-stg-job-1",
  manifestMatches: true,
  policyId: "cloud_run_jobs_l4_v1",
  retriedCount: 0,
  runtimeServiceAccount: configuration.runtimeServiceAccount,
  state: "running",
  taskCount: 1,
};

const verifiedIdentity: VerifiedGoogleIdentity = {
  audience: configuration.identityAudience,
  expiresAt: "2026-08-11T01:00:00.000Z",
  issuedAt: "2026-08-11T00:00:00.000Z",
  issuer: configuration.identityIssuer,
  serviceAccountEmail: configuration.runtimeServiceAccount,
  subjectId: "112010400000000710080",
};

class FixedIds {
  readonly #values: string[];

  constructor(values = [CHALLENGE_ID, SESSION_ID, "01ARZ3NDEKTSV4RRFFQ69G5FB0"]) {
    this.#values = [...values];
  }

  next(): string {
    const value = this.#values.shift();
    if (value === undefined) throw new Error("test id sequence exhausted");
    return value;
  }
}

function createPorts(
  overrides: {
    readonly cleanup?: CloudRunRuntimeServicePorts["cleanup"];
    readonly identity?: VerifiedGoogleIdentity;
    readonly readback?: ControllerExecutionReadback;
    readonly store?: InMemoryCloudRunRuntimeStore;
  } = {},
): CloudRunRuntimeServicePorts {
  return {
    attestor: { read: () => Promise.resolve(overrides.readback ?? readback) },
    capabilities: {
      issue: ({ context: selected }) =>
        Promise.resolve({
          results: {
            artifacts: selected.options.outputFormats.map((format) => ({
              format,
              key: `results/${selected.ownerHash}/${selected.jobId}/${selected.attemptId}/transcript.${format === "markdown" ? "md" : format}`,
              putUrl: `https://storage.example.invalid/transcript.${format}?signature=dummy`,
            })),
            manifestPutUrl: "https://storage.example.invalid/manifest.json?signature=dummy",
          },
          source: {
            expectedEtag: selected.sourceEtag,
            expectedSizeBytes: selected.sourceSizeBytes,
            getUrl: "https://storage.example.invalid/source.wav?signature=dummy",
          },
        }),
    },
    cleanup: overrides.cleanup ?? { schedule: () => Promise.resolve() },
    clock: { now: () => new Date("2026-08-11T00:00:00.000Z") },
    ids: new FixedIds(),
    identity: { verify: () => Promise.resolve(overrides.identity ?? verifiedIdentity) },
    secrets: new HmacRuntimeSecretDeriver(new Uint8Array(32).fill(7)),
    signatures: new WebCryptoEd25519Verifier(),
    store: overrides.store ?? new InMemoryCloudRunRuntimeStore([context]),
  };
}

function bootstrapRequest(publicKey: string): CloudRunBootstrapRequest {
  return {
    bootstrapRequestId: BOOTSTRAP_ID,
    environment: "staging",
    executionHandle: HANDLE,
    executionName: readback.executionName,
    identityToken: TOKEN,
    jobName: readback.jobName,
    policyId: "cloud_run_jobs_l4_v1",
    publicKey,
    taskAttempt: 0,
    taskCount: 1,
    taskIndex: 0,
  };
}

async function claimRequest(
  privateKey: CryptoKey,
  challenge: string,
): Promise<CloudRunClaimRequest> {
  return {
    bootstrapRequestId: BOOTSTRAP_ID,
    challengeId: CHALLENGE_ID,
    environment: "staging",
    executionHandle: HANDLE,
    executionName: readback.executionName,
    jobName: readback.jobName,
    policyId: "cloud_run_jobs_l4_v1",
    signature: await sign(privateKey, [
      "scribe-drop-cloud-run-claim-v1",
      challenge,
      CHALLENGE_ID,
      BOOTSTRAP_ID,
      HANDLE,
      readback.executionName,
      readback.jobName,
    ]),
    taskAttempt: 0,
    taskCount: 1,
    taskIndex: 0,
  };
}

describe("CloudRunRuntimeService", () => {
  it("replays bootstrap and claim loss exactly, sequences heartbeats, and revokes on terminal", async () => {
    const keys = await keyPair();
    const store = new InMemoryCloudRunRuntimeStore([context]);
    const ports = createPorts({ store });
    const service = new CloudRunRuntimeService(configuration, ports);
    const bootstrap = await service.bootstrap(bootstrapRequest(keys.publicKey));

    const restarted = new CloudRunRuntimeService(configuration, {
      ...createPorts({ store }),
      ids: new FixedIds(["01ARZ3NDEKTSV4RRFFQ69G5FB1", "01ARZ3NDEKTSV4RRFFQ69G5FB2"]),
    });
    await expect(restarted.bootstrap(bootstrapRequest(keys.publicKey))).resolves.toEqual(bootstrap);

    const claim = await claimRequest(keys.privateKey, bootstrap.challenge);
    const claimed = await service.claim(claim);
    await expect(restarted.claim(claim)).resolves.toEqual(claimed);
    await expect(
      service.acknowledge({
        executionHandle: HANDLE,
        sequence: 0,
        sessionId: claimed.session.sessionId,
        sessionToken: claimed.session.token,
        state: "ready",
      }),
    ).resolves.toEqual({ acknowledged: true });
    await expect(
      service.heartbeat({
        executionHandle: HANDLE,
        progress: "transcribe",
        sequence: 1,
        sessionId: claimed.session.sessionId,
        sessionToken: claimed.session.token,
      }),
    ).resolves.toEqual({ cancelRequested: false });
    const terminal: CloudRunTerminalRequest = {
      artifactCount: 2,
      durationSeconds: 60,
      errorCode: null,
      executionHandle: HANDLE,
      manifestWritten: true,
      segmentCount: 4,
      sequence: 2,
      sessionId: claimed.session.sessionId,
      sessionToken: claimed.session.token,
      status: "succeeded",
    };
    await expect(service.terminal(terminal)).resolves.toEqual({
      accepted: true,
      cleanupPending: true,
    });
    await expect(service.terminal(terminal)).resolves.toEqual({
      accepted: true,
      cleanupPending: true,
    });
    await expect(
      service.heartbeat({
        executionHandle: HANDLE,
        progress: "publish",
        sequence: 3,
        sessionId: claimed.session.sessionId,
        sessionToken: claimed.session.token,
      }),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("rejects forged claim signatures before issuing capabilities", async () => {
    const keys = await keyPair();
    let issueCount = 0;
    const ports = createPorts();
    const service = new CloudRunRuntimeService(configuration, {
      ...ports,
      capabilities: {
        issue: async (input) => {
          issueCount += 1;
          return ports.capabilities.issue(input);
        },
      },
    });
    await service.bootstrap(bootstrapRequest(keys.publicKey));
    const claim = await claimRequest(
      keys.privateKey,
      "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    );

    await expect(service.claim(claim)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    expect(issueCount).toBe(0);
  });

  it.each([
    ["wrong audience", { ...verifiedIdentity, audience: "https://wrong.example.invalid" }],
    ["stale identity", { ...verifiedIdentity, expiresAt: "2026-08-10T23:59:59.000Z" }],
    [
      "wrong service account",
      { ...verifiedIdentity, serviceAccountEmail: "other@scribe-phase14.iam.gserviceaccount.com" },
    ],
    ["invalid subject ID", { ...verifiedIdentity, subjectId: configuration.runtimeServiceAccount }],
  ])("rejects %s", async (_case, identity) => {
    const keys = await keyPair();
    const service = new CloudRunRuntimeService(configuration, createPorts({ identity }));
    await expect(service.bootstrap(bootstrapRequest(keys.publicKey))).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });

  it("rejects controller manifest drift and stale session sequence", async () => {
    const keys = await keyPair();
    const drifted = new CloudRunRuntimeService(
      configuration,
      createPorts({ readback: { ...readback, manifestMatches: false } }),
    );
    await expect(drifted.bootstrap(bootstrapRequest(keys.publicKey))).rejects.toMatchObject({
      code: "RESOURCE_DRIFT",
    });

    const service = new CloudRunRuntimeService(configuration, createPorts());
    const bootstrap = await service.bootstrap(bootstrapRequest(keys.publicKey));
    const claimed = await service.claim(await claimRequest(keys.privateKey, bootstrap.challenge));
    await expect(
      service.heartbeat({
        executionHandle: HANDLE,
        progress: "download",
        sequence: 0,
        sessionId: claimed.session.sessionId,
        sessionToken: claimed.session.token,
      }),
    ).rejects.toMatchObject({ code: "INVALID_SEQUENCE" });
    await expect(
      service.heartbeat({
        executionHandle: HANDLE,
        progress: "download",
        sequence: 1,
        sessionId: claimed.session.sessionId,
        sessionToken: claimed.session.token,
      }),
    ).rejects.toMatchObject({ code: "INVALID_SEQUENCE" });
  });

  it("rejects a conflicting terminal replay after persisting the first report", async () => {
    const keys = await keyPair();
    const service = new CloudRunRuntimeService(configuration, createPorts());
    const bootstrap = await service.bootstrap(bootstrapRequest(keys.publicKey));
    const claimed = await service.claim(await claimRequest(keys.privateKey, bootstrap.challenge));
    await service.acknowledge({
      executionHandle: HANDLE,
      sequence: 0,
      sessionId: claimed.session.sessionId,
      sessionToken: claimed.session.token,
      state: "ready",
    });
    const terminal: CloudRunTerminalRequest = {
      artifactCount: 0,
      durationSeconds: 1,
      errorCode: "TRANSCRIPTION_FAILED",
      executionHandle: HANDLE,
      manifestWritten: false,
      segmentCount: 0,
      sequence: 1,
      sessionId: claimed.session.sessionId,
      sessionToken: claimed.session.token,
      status: "failed",
    };
    await service.terminal(terminal);
    await expect(
      service.terminal({ ...terminal, errorCode: "INTERNAL_ERROR" }),
    ).rejects.toBeInstanceOf(CloudRunRuntimeError);
  });

  it("retries exact cleanup scheduling after terminal response loss", async () => {
    const keys = await keyPair();
    let cleanupCalls = 0;
    const service = new CloudRunRuntimeService(
      configuration,
      createPorts({
        cleanup: {
          schedule: () => {
            cleanupCalls += 1;
            return cleanupCalls === 1
              ? Promise.reject(new Error("simulated response loss"))
              : Promise.resolve();
          },
        },
      }),
    );
    const bootstrap = await service.bootstrap(bootstrapRequest(keys.publicKey));
    const claimed = await service.claim(await claimRequest(keys.privateKey, bootstrap.challenge));
    await service.acknowledge({
      executionHandle: HANDLE,
      sequence: 0,
      sessionId: claimed.session.sessionId,
      sessionToken: claimed.session.token,
      state: "ready",
    });
    const terminal: CloudRunTerminalRequest = {
      artifactCount: 0,
      durationSeconds: 1,
      errorCode: "INTERNAL_ERROR",
      executionHandle: HANDLE,
      manifestWritten: false,
      segmentCount: 0,
      sequence: 1,
      sessionId: claimed.session.sessionId,
      sessionToken: claimed.session.token,
      status: "failed",
    };

    await expect(service.terminal(terminal)).rejects.toThrow("simulated response loss");
    await expect(service.terminal(terminal)).resolves.toEqual({
      accepted: true,
      cleanupPending: true,
    });
    expect(cleanupCalls).toBe(2);
  });
});
