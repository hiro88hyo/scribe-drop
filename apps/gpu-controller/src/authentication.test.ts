import { describe, expect, it } from "vitest";
import {
  CLOUD_RUN_CONTROLLER_ATTEST_PATH,
  type CloudRunControllerAttestationRequest,
} from "@scribe-drop/contracts";

import {
  authenticateControllerRequest,
  buildControllerSignature,
  type ControllerClock,
  type ControllerHmacKeys,
} from "./authentication.js";
import {
  controllerRequestSchema,
  parseControllerRequest,
  type ControllerRequest,
} from "./contracts.js";
import { InMemoryControlStore, defaultSyntheticAuthorizations } from "./control-store.js";
import { GpuControllerService } from "./controller-service.js";
import { createControllerHttpHandler, type ControllerLogRecord } from "./http-handler.js";
import type { CloudRunAdminPort } from "./provider.js";

const SECRET = new TextEncoder().encode("phase12-controller-hmac-secret-value");
const NOW = new Date("2026-08-11T00:00:20.000Z");
const REQUEST: ControllerRequest = {
  schemaVersion: 1,
  environment: "staging",
  action: "create",
  requestId: "01K28000000000000000000000",
  executionHandle: "h".repeat(43),
  policyId: "cloud_run_jobs_l4_v1",
  expectedVersion: 0,
  issuedAt: "2026-08-11T00:00:00.000Z",
  expiresAt: "2026-08-11T00:01:00.000Z",
};
const ATTESTATION_REQUEST: CloudRunControllerAttestationRequest = {
  environment: "staging",
  executionHandle: REQUEST.executionHandle,
  expiresAt: REQUEST.expiresAt,
  issuedAt: REQUEST.issuedAt,
  policyId: REQUEST.policyId,
  requestId: "01K28000000000000000000001",
  schemaVersion: 1,
};

const clock: ControllerClock = { now: () => new Date(NOW) };
const keys: ControllerHmacKeys = {
  get: (keyId) => Promise.resolve(keyId === "primary" ? SECRET : null),
};

describe("controller authentication boundary", () => {
  it("accepts only the exact signed method, path, semantic body, and active key", async () => {
    const body = JSON.stringify(REQUEST);
    const signature = await buildControllerSignature(
      { method: "POST", path: "/v1/executions", body, request: REQUEST },
      SECRET,
    );
    const base = {
      method: "POST",
      path: "/v1/executions",
      body,
      keyId: "primary",
      signature,
      request: REQUEST,
    } as const;

    expect(await authenticateControllerRequest(base, clock, keys)).toBe("authenticated");
    expect(await authenticateControllerRequest({ ...base, path: "/v1/other" }, clock, keys)).toBe(
      "rejected",
    );
    expect(
      await authenticateControllerRequest(
        { ...base, request: { ...REQUEST, action: "cleanup" } },
        clock,
        keys,
      ),
    ).toBe("rejected");
    expect(await authenticateControllerRequest({ ...base, keyId: "secondary" }, clock, keys)).toBe(
      "rejected",
    );
  });

  it("rejects expired, overlong, unknown-field, and oversized requests", async () => {
    const expired = {
      ...REQUEST,
      issuedAt: "2026-08-10T23:58:00.000Z",
      expiresAt: "2026-08-10T23:59:00.000Z",
    };
    const body = JSON.stringify(expired);
    const signature = await buildControllerSignature(
      { method: "POST", path: "/v1/executions", body, request: expired },
      SECRET,
    );
    expect(
      await authenticateControllerRequest(
        {
          method: "POST",
          path: "/v1/executions",
          body,
          keyId: "primary",
          signature,
          request: expired,
        },
        clock,
        keys,
      ),
    ).toBe("expired");
    expect(
      controllerRequestSchema.safeParse({ ...REQUEST, image: "caller-controlled" }).success,
    ).toBe(false);
    expect(() => parseControllerRequest(`{"padding":"${"x".repeat(4_096)}"}`)).toThrow(
      "INVALID_REQUEST",
    );
  });

  it("rejects unauthenticated HTTP requests before any provider call and logs only allowlisted fields", async () => {
    let providerCalls = 0;
    const provider: CloudRunAdminPort = {
      cancelExecution: () => Promise.reject(new Error("unexpected")),
      createJob: () => {
        providerCalls += 1;
        return Promise.resolve({ outcome: "unknown" });
      },
      deleteExecution: () => Promise.reject(new Error("unexpected")),
      deleteJob: () => Promise.reject(new Error("unexpected")),
      getJob: () => Promise.resolve({ outcome: "not_found" }),
      getOperation: () => Promise.resolve({ outcome: "succeeded" }),
      listExecutions: () => Promise.resolve({ outcome: "found", executions: [] }),
      runJob: () => Promise.reject(new Error("unexpected")),
    };
    const service = new GpuControllerService({
      environment: "staging",
      manifestConfiguration: {
        environment: "staging",
        projectId: "scribe-phase12",
        imageDigest: `asia-southeast1-docker.pkg.dev/scribe-phase12/worker/runtime@sha256:${"a".repeat(64)}`,
        runtimeServiceAccount: "runtime@scribe-phase12.iam.gserviceaccount.com",
        orchestratorOrigin: "https://orchestrator.example.test/",
        resultHost: "storage.example.test",
        sourceHost: "storage.example.test",
      },
      clock,
      provider,
      store: new InMemoryControlStore(defaultSyntheticAuthorizations()),
    });
    const logs: ControllerLogRecord[] = [];
    const handler = createControllerHttpHandler({
      clock,
      keys,
      logger: { emit: (record) => logs.push(record) },
      service,
    });
    const response = await handler(
      new Request("https://controller.example.test/v1/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(REQUEST),
      }),
    );

    expect(response.status).toBe(401);
    expect(providerCalls).toBe(0);
    expect(logs).toEqual([
      {
        event: "controller_request",
        action: "create",
        outcome: "rejected",
        errorCode: "AUTHENTICATION_FAILED",
        policyId: "cloud_run_jobs_l4_v1",
        durationMs: 0,
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain(REQUEST.executionHandle);
    expect(JSON.stringify(logs)).not.toContain(REQUEST.requestId);
    expect(JSON.stringify(logs)).not.toContain("signature");
  });

  it("accepts a valid HTTP signature but retains the default zero-cost gate", async () => {
    const body = JSON.stringify(REQUEST);
    const signature = await buildControllerSignature(
      { method: "POST", path: "/v1/executions", body, request: REQUEST },
      SECRET,
    );
    const provider: CloudRunAdminPort = {
      cancelExecution: () => Promise.reject(new Error("unexpected")),
      createJob: () => Promise.reject(new Error("budget gate failed")),
      deleteExecution: () => Promise.reject(new Error("unexpected")),
      deleteJob: () => Promise.reject(new Error("unexpected")),
      getJob: () => Promise.resolve({ outcome: "not_found" }),
      getOperation: () => Promise.resolve({ outcome: "succeeded" }),
      listExecutions: () => Promise.resolve({ outcome: "found", executions: [] }),
      runJob: () => Promise.reject(new Error("unexpected")),
    };
    const service = new GpuControllerService({
      environment: "staging",
      manifestConfiguration: {
        environment: "staging",
        projectId: "scribe-phase12",
        imageDigest: `asia-southeast1-docker.pkg.dev/scribe-phase12/worker/runtime@sha256:${"a".repeat(64)}`,
        runtimeServiceAccount: "runtime@scribe-phase12.iam.gserviceaccount.com",
        orchestratorOrigin: "https://orchestrator.example.test/",
        resultHost: "storage.example.test",
        sourceHost: "storage.example.test",
      },
      clock,
      provider,
      store: new InMemoryControlStore(defaultSyntheticAuthorizations()),
    });
    const handler = createControllerHttpHandler({
      clock,
      keys,
      logger: { emit: () => undefined },
      service,
    });
    const response = await handler(
      new Request("https://controller.example.test/v1/executions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-scribe-key-id": "primary",
          "x-scribe-signature": signature,
        },
        body,
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      outcome: "rejected",
      errorCode: "BUDGET_EXHAUSTED",
    });
  });

  it("authenticates the exact attestation path and returns no resource for an unknown handle", async () => {
    const body = JSON.stringify(ATTESTATION_REQUEST);
    const signature = await buildControllerSignature(
      {
        body,
        method: "POST",
        path: CLOUD_RUN_CONTROLLER_ATTEST_PATH,
        request: ATTESTATION_REQUEST,
      },
      SECRET,
    );
    const provider: CloudRunAdminPort = {
      cancelExecution: () => Promise.reject(new Error("unexpected")),
      createJob: () => Promise.reject(new Error("unexpected")),
      deleteExecution: () => Promise.reject(new Error("unexpected")),
      deleteJob: () => Promise.reject(new Error("unexpected")),
      getJob: () => Promise.reject(new Error("unexpected")),
      getOperation: () => Promise.reject(new Error("unexpected")),
      listExecutions: () => Promise.reject(new Error("unexpected")),
      runJob: () => Promise.reject(new Error("unexpected")),
    };
    const service = new GpuControllerService({
      clock,
      environment: "staging",
      manifestConfiguration: {
        environment: "staging",
        imageDigest: `asia-southeast1-docker.pkg.dev/scribe-phase12/worker/runtime@sha256:${"a".repeat(64)}`,
        orchestratorOrigin: "https://orchestrator.example.test/",
        projectId: "scribe-phase12",
        resultHost: "storage.example.test",
        runtimeServiceAccount: "runtime@scribe-phase12.iam.gserviceaccount.com",
        sourceHost: "storage.example.test",
      },
      provider,
      store: new InMemoryControlStore(defaultSyntheticAuthorizations()),
    });
    const logs: ControllerLogRecord[] = [];
    const handler = createControllerHttpHandler({
      clock,
      keys,
      logger: { emit: (record) => logs.push(record) },
      service,
    });
    const response = await handler(
      new Request(`https://controller.example.test${CLOUD_RUN_CONTROLLER_ATTEST_PATH}`, {
        body,
        headers: {
          "content-type": "application/json",
          "x-scribe-key-id": "primary",
          "x-scribe-signature": signature,
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      attestation: null,
      executionHandle: ATTESTATION_REQUEST.executionHandle,
      outcome: "not_found",
      requestId: ATTESTATION_REQUEST.requestId,
      schemaVersion: 1,
    });
    expect(logs).toEqual([
      {
        action: "attest",
        durationMs: 0,
        errorCode: null,
        event: "controller_request",
        outcome: "accepted",
        policyId: "cloud_run_jobs_l4_v1",
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain(ATTESTATION_REQUEST.executionHandle);
  });
});
