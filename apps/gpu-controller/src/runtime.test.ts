import { describe, expect, it } from "vitest";

import { buildControllerSignature, type ControllerHmacKeys } from "./authentication.js";
import type { ControllerRequest } from "./contracts.js";
import { defaultSyntheticAuthorizations } from "./control-store.js";
import {
  createFirestoreEnvironmentDocument,
  type FirestoreControlDatabase,
  type FirestoreDocumentTransaction,
} from "./firestore-control-store.js";
import type { ControllerLogRecord } from "./http-handler.js";
import {
  controllerRuntimeConfigurationSchema,
  createControllerRuntimeHandler,
  type ControllerRuntimeConfiguration,
} from "./runtime.js";

const NOW = new Date("2026-08-11T00:00:20.000Z");
const SECRET = new TextEncoder().encode("phase14-controller-hmac-secret-value");
const REQUEST: ControllerRequest = {
  action: "create",
  environment: "staging",
  executionHandle: "h".repeat(43),
  expectedVersion: 0,
  expiresAt: "2026-08-11T00:01:00.000Z",
  issuedAt: "2026-08-11T00:00:00.000Z",
  policyId: "cloud_run_jobs_l4_v1",
  requestId: "01K28000000000000000000000",
  schemaVersion: 1,
};

const configuration: ControllerRuntimeConfiguration = {
  authorization: defaultSyntheticAuthorizations().staging,
  firestore: {
    databaseId: "scribe-staging-controller",
    projectId: "scribe-phase14",
  },
  manifest: {
    environment: "staging",
    imageDigest: `asia-southeast1-docker.pkg.dev/scribe-phase14/worker/runtime@sha256:${"a".repeat(64)}`,
    orchestratorOrigin: "https://orchestrator.example.test/",
    projectId: "scribe-phase14",
    resultHost: "storage.example.test",
    runtimeServiceAccount: "runtime@scribe-phase14.iam.gserviceaccount.com",
    sourceHost: "storage.example.test",
  },
};

class DisabledFirestoreDatabase implements FirestoreControlDatabase {
  readonly #environment = createFirestoreEnvironmentDocument(
    defaultSyntheticAuthorizations().staging,
    NOW.toISOString(),
  );

  // The fake mirrors an asynchronous remote document read.
  // eslint-disable-next-line @typescript-eslint/require-await
  async get(): Promise<unknown> {
    return null;
  }

  runTransaction<T>(
    callback: (transaction: FirestoreDocumentTransaction) => Promise<T>,
  ): Promise<T> {
    return callback({
      create: () => {
        throw new Error("disabled authorization attempted a write");
      },
      get: (path) =>
        Promise.resolve(
          path === "scribe_drop_controller_environments/staging" ? this.#environment : null,
        ),
      set: () => {
        throw new Error("disabled authorization attempted a write");
      },
    });
  }
}

describe("controller runtime composition", () => {
  it("rejects cross-project and partially enabled configuration before wiring", () => {
    expect(
      controllerRuntimeConfigurationSchema.safeParse({
        ...configuration,
        manifest: { ...configuration.manifest, projectId: "scribe-other14" },
      }).success,
    ).toBe(false);
    expect(
      controllerRuntimeConfigurationSchema.safeParse({
        ...configuration,
        authorization: {
          ...configuration.authorization,
          epoch: "partial",
          maxExecutions: 1,
        },
      }).success,
    ).toBe(false);
    expect(
      controllerRuntimeConfigurationSchema.safeParse({
        ...configuration,
        manifest: {
          ...configuration.manifest,
          runtimeServiceAccount: "runtime@scribe-other14.iam.gserviceaccount.com",
        },
      }).success,
    ).toBe(false);
  });

  it("keeps the durable zero-budget gate ahead of access-token and provider calls", async () => {
    let tokenCalls = 0;
    let providerCalls = 0;
    const logs: ControllerLogRecord[] = [];
    const keys: ControllerHmacKeys = {
      get: (keyId) => Promise.resolve(keyId === "primary" ? SECRET : null),
    };
    const handler = createControllerRuntimeHandler(configuration, {
      clock: { now: () => new Date(NOW) },
      database: new DisabledFirestoreDatabase(),
      keys,
      logger: { emit: (record) => logs.push(record) },
      providerFetch: () => {
        providerCalls += 1;
        return Promise.reject(new Error("provider call escaped budget gate"));
      },
      tokens: {
        getAccessToken: () => {
          tokenCalls += 1;
          return Promise.reject(new Error("token call escaped budget gate"));
        },
      },
    });
    const body = JSON.stringify(REQUEST);
    const signature = await buildControllerSignature(
      { body, method: "POST", path: "/v1/executions", request: REQUEST },
      SECRET,
    );
    const response = await handler(
      new Request("https://controller.example.test/v1/executions", {
        body,
        headers: {
          "content-type": "application/json",
          "x-scribe-key-id": "primary",
          "x-scribe-signature": signature,
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: "BUDGET_EXHAUSTED",
      outcome: "rejected",
    });
    expect(tokenCalls).toBe(0);
    expect(providerCalls).toBe(0);
    expect(logs).toEqual([
      {
        action: "create",
        durationMs: 0,
        errorCode: "BUDGET_EXHAUSTED",
        event: "controller_request",
        outcome: "rejected",
        policyId: "cloud_run_jobs_l4_v1",
      },
    ]);
  });
});
