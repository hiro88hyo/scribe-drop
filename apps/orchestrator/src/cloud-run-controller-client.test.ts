import {
  CLOUD_RUN_CONTROLLER_ATTEST_PATH,
  CLOUD_RUN_CONTROLLER_MUTATION_PATH,
  cloudRunControllerAttestationRequestSchema,
  cloudRunControllerRequestSchema,
} from "@scribe-drop/contracts";
import { describe, expect, it } from "vitest";

import {
  buildCloudRunControllerClientSignature,
  CloudRunControllerClient,
} from "./cloud-run-controller-client.js";

const SECRET = new TextEncoder().encode("phase14-controller-hmac-secret-value");
const HANDLE = "h".repeat(43);
const NOW = new Date("2026-08-11T00:00:00.000Z");
const IDS = [
  "01K28000000000000000000001",
  "01K28000000000000000000002",
  "01K28000000000000000000003",
];

function body(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") throw new Error("expected JSON request body");
  return JSON.parse(init.body) as unknown;
}

function url(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === "string" ? input : input.url);
}

function client(providerFetch: typeof fetch): CloudRunControllerClient {
  let index = 0;
  return new CloudRunControllerClient(
    {
      baseUrl: "https://controller.example.invalid/",
      environment: "staging",
      keyId: "primary",
      requestLifetimeMs: 30_000,
      secret: SECRET,
    },
    {
      clock: { now: () => new Date(NOW) },
      fetch: providerFetch,
      ids: {
        next: () => {
          const id = IDS[index];
          index += 1;
          if (id === undefined) throw new Error("test ID sequence exhausted");
          return id;
        },
      },
    },
  );
}

async function expectSignature(
  requestUrl: URL,
  init: RequestInit | undefined,
  request: { readonly requestId: string; readonly issuedAt: string; readonly expiresAt: string },
): Promise<void> {
  const expected = await buildCloudRunControllerClientSignature(
    { method: "POST", path: requestUrl.pathname, request },
    SECRET,
  );
  expect(new Headers(init?.headers).get("x-scribe-signature")).toBe(expected);
  expect(new Headers(init?.headers).get("x-scribe-key-id")).toBe("primary");
  expect(new Request(requestUrl, init).redirect).toBe("manual");
}

function attestationResponse(requestId: string): Response {
  return Response.json({
    attestation: {
      activeExecutionCount: 1,
      controllerVersion: 7,
      environment: "staging",
      executionHandle: HANDLE,
      executionName: "execution-1",
      jobName: "job-1",
      manifestMatches: true,
      policyId: "cloud_run_jobs_l4_v1",
      retriedCount: 0,
      runtimeServiceAccount: "runtime@scribe-phase14.iam.gserviceaccount.com",
      state: "running",
      taskCount: 1,
    },
    executionHandle: HANDLE,
    outcome: "found",
    requestId,
    schemaVersion: 1,
  });
}

describe("Cloud Run controller Orchestrator client", () => {
  it("reads a bounded live attestation with an exact HMAC request", async () => {
    const calls: URL[] = [];
    const providerFetch: typeof fetch = async function (this: unknown, input, init) {
      expect(this).toBeUndefined();
      const requestUrl = url(input);
      calls.push(requestUrl);
      const request = cloudRunControllerAttestationRequestSchema.parse(body(init));
      await expectSignature(requestUrl, init, request);
      return attestationResponse(request.requestId);
    };

    await expect(client(providerFetch).read(HANDLE)).resolves.toEqual({
      activeExecutionCount: 1,
      environment: "staging",
      executionHandle: HANDLE,
      executionName: "execution-1",
      jobName: "job-1",
      manifestMatches: true,
      policyId: "cloud_run_jobs_l4_v1",
      retriedCount: 0,
      runtimeServiceAccount: "runtime@scribe-phase14.iam.gserviceaccount.com",
      state: "running",
      taskCount: 1,
    });
    expect(calls.map(({ pathname }) => pathname)).toEqual([CLOUD_RUN_CONTROLLER_ATTEST_PATH]);
  });

  it("attests the current version before sending one cleanup mutation", async () => {
    const calls: URL[] = [];
    const providerFetch: typeof fetch = async (input, init) => {
      const requestUrl = url(input);
      calls.push(requestUrl);
      if (requestUrl.pathname === CLOUD_RUN_CONTROLLER_ATTEST_PATH) {
        const request = cloudRunControllerAttestationRequestSchema.parse(body(init));
        await expectSignature(requestUrl, init, request);
        return attestationResponse(request.requestId);
      }
      const request = cloudRunControllerRequestSchema.parse(body(init));
      await expectSignature(requestUrl, init, request);
      expect(request).toMatchObject({ action: "cleanup", expectedVersion: 7 });
      return Response.json({
        errorCode: null,
        executionHandle: HANDLE,
        outcome: "cleaned",
        requestId: request.requestId,
        schemaVersion: 1,
        version: 8,
      });
    };
    const selected = client(providerFetch);

    await expect(
      selected.schedule({ environment: "staging", executionHandle: HANDLE }),
    ).resolves.toBeUndefined();
    expect(calls.map(({ pathname }) => pathname)).toEqual([
      CLOUD_RUN_CONTROLLER_ATTEST_PATH,
      CLOUD_RUN_CONTROLLER_MUTATION_PATH,
    ]);
  });

  it("does not retry an unknown cleanup mutation outcome", async () => {
    let calls = 0;
    const providerFetch: typeof fetch = (input, init) => {
      calls += 1;
      const requestUrl = url(input);
      if (requestUrl.pathname === CLOUD_RUN_CONTROLLER_ATTEST_PATH) {
        const request = cloudRunControllerAttestationRequestSchema.parse(body(init));
        return Promise.resolve(attestationResponse(request.requestId));
      }
      return Promise.reject(new Error("response lost"));
    };
    await expect(
      client(providerFetch).schedule({ environment: "staging", executionHandle: HANDLE }),
    ).rejects.toThrow("outcome is unknown");
    expect(calls).toBe(2);
  });

  it("rejects redirects, oversized bodies, and response identity drift", async () => {
    const responses = [
      new Response(null, { status: 302, headers: { location: "https://other.invalid" } }),
      new Response("{}", {
        headers: { "content-length": "20000", "content-type": "application/json" },
      }),
      Response.json({
        attestation: null,
        executionHandle: HANDLE,
        outcome: "not_found",
        requestId: "01K28000000000000000000999",
        schemaVersion: 1,
      }),
    ];
    const providerFetch: typeof fetch = () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("test response sequence exhausted");
      return Promise.resolve(response);
    };
    const selected = client(providerFetch);
    await expect(selected.read(HANDLE)).rejects.toThrow("request failed");
    await expect(selected.read(HANDLE)).rejects.toThrow("response was rejected");
    await expect(selected.read(HANDLE)).rejects.toThrow("response identity mismatch");
  });
});
