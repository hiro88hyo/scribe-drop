import { describe, expect, it, vi } from "vitest";

import type { AccessTokenProvider } from "./cloud-run-client.js";
import type { ControllerControlPlaneReadbackExpectation } from "./control-plane-evidence.js";
import { GoogleControllerControlPlaneReadbackClient } from "./control-plane-readback-client.js";
import { defaultSyntheticAuthorizations } from "./control-store.js";
import { createControllerServiceDeploymentPlan } from "./service-deployment.js";

const expectation: ControllerControlPlaneReadbackExpectation = {
  binaryAuthorization: {
    attestors: ["projects/scribe-phase14/attestors/release-candidate"],
    projectId: "scribe-phase14",
  },
  projectNumber: "123456789012",
  deployment: {
    authorization: defaultSyntheticAuthorizations().staging,
    controllerImageDigest: `asia-southeast1-docker.pkg.dev/scribe-phase14/controller/runtime@sha256:${"b".repeat(64)}`,
    controllerServiceAccount: "gpu-controller@scribe-phase14.iam.gserviceaccount.com",
    firestore: { databaseId: "scribe-staging-controller", projectId: "scribe-phase14" },
    manifest: {
      environment: "staging",
      imageDigest: `asia-southeast1-docker.pkg.dev/scribe-phase14/worker/runtime@sha256:${"a".repeat(64)}`,
      orchestratorOrigin: "https://orchestrator.example.test/",
      projectId: "scribe-phase14",
      resultHost: "storage.example.test",
      runtimeServiceAccount: "gpu-runtime@scribe-phase14.iam.gserviceaccount.com",
      sourceHost: "storage.example.test",
    },
    primaryHmacSecret: { name: "scribe-drop-staging-controller-primary", version: "7" },
    serviceName: "scribe-drop-staging-gpu-controller",
  },
};

const serviceResource =
  "projects/scribe-phase14/locations/asia-southeast1/services/scribe-drop-staging-gpu-controller";
const secretResource = "projects/scribe-phase14/secrets/scribe-drop-staging-controller-primary";
const canonicalSecretResource =
  "projects/123456789012/secrets/scribe-drop-staging-controller-primary";
const urls = {
  binaryAuthorizationPolicy:
    "https://binaryauthorization.googleapis.com/v1/projects/scribe-phase14/policy",
  primarySecret: `https://secretmanager.googleapis.com/v1/${secretResource}`,
  primarySecretIamPolicy: `https://secretmanager.googleapis.com/v1/${secretResource}:getIamPolicy?options.requestedPolicyVersion=3`,
  primarySecretVersion: `https://secretmanager.googleapis.com/v1/${secretResource}/versions/7`,
  service: `https://run.googleapis.com/v2/${serviceResource}`,
  serviceIamPolicy: `https://run.googleapis.com/v2/${serviceResource}:getIamPolicy?options.requestedPolicyVersion=3`,
} as const;

function responses(): ReadonlyMap<string, unknown> {
  const plan = createControllerServiceDeploymentPlan(expectation.deployment);
  const revision = "scribe-drop-staging-gpu-controller-00001-abc";
  const serviceUri = "https://scribe-drop-staging-gpu-controller-abcdef-as.a.run.app/";
  return new Map<string, unknown>([
    [
      urls.service,
      {
        binaryAuthorization: { useDefault: true },
        conditions: [{ state: "CONDITION_SUCCEEDED", type: "Ready" }],
        createTime: "2026-08-11T00:00:00Z",
        etag: "service-etag",
        generation: "1",
        ingress: plan.ingress,
        invokerIamDisabled: true,
        labels: plan.labels,
        latestCreatedRevision: revision,
        latestReadyRevision: revision,
        launchStage: "GA",
        name: plan.name,
        observedGeneration: "1",
        reconciling: false,
        scaling: plan.scaling,
        template: {
          containers: plan.template.containers,
          executionEnvironment: plan.template.executionEnvironment,
          healthCheckDisabled: false,
          labels: plan.template.labels,
          maxInstanceRequestConcurrency: plan.template.maxInstanceRequestConcurrency,
          scaling: plan.template.scaling,
          serviceAccount: plan.template.serviceAccount,
          sessionAffinity: false,
          timeout: plan.template.timeout,
          volumes: [],
        },
        terminalCondition: { state: "CONDITION_SUCCEEDED", type: "Ready" },
        traffic: plan.traffic,
        trafficStatuses: [
          {
            percent: 100,
            revision,
            type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST",
            uri: serviceUri,
          },
        ],
        uid: "123e4567-e89b-42d3-a456-426614174000",
        updateTime: "2026-08-11T00:01:00Z",
        uri: serviceUri,
        urls: [serviceUri],
      },
    ],
    [urls.serviceIamPolicy, { bindings: [], etag: "service-iam-etag", version: 1 }],
    [
      urls.primarySecret,
      {
        annotations: {},
        createTime: "2026-08-11T00:00:00Z",
        etag: "secret-etag",
        labels: {
          "scribe-drop-component": "gpu-controller",
          "scribe-drop-environment": "staging",
        },
        name: canonicalSecretResource,
        replication: { userManaged: { replicas: [{ location: "asia-southeast1" }] } },
        topics: [],
        versionAliases: {},
      },
    ],
    [
      urls.primarySecretVersion,
      {
        clientSpecifiedPayloadChecksum: true,
        createTime: "2026-08-11T00:01:00Z",
        etag: "version-etag",
        name: `${canonicalSecretResource}/versions/7`,
        replicationStatus: {
          userManaged: { replicas: [{ location: "asia-southeast1" }] },
        },
        state: "ENABLED",
      },
    ],
    [
      urls.primarySecretIamPolicy,
      {
        bindings: [
          {
            members: ["serviceAccount:gpu-controller@scribe-phase14.iam.gserviceaccount.com"],
            role: "roles/secretmanager.secretAccessor",
          },
        ],
        etag: "secret-iam-etag",
        version: 1,
      },
    ],
    [
      urls.binaryAuthorizationPolicy,
      {
        admissionWhitelistPatterns: [],
        clusterAdmissionRules: {},
        defaultAdmissionRule: {
          enforcementMode: "ENFORCED_BLOCK_AND_AUDIT_LOG",
          evaluationMode: "REQUIRE_ATTESTATION",
          requireAttestationsBy: expectation.binaryAuthorization.attestors,
        },
        etag: "binauth-etag",
        globalPolicyEvaluationMode: "ENABLE",
        istioServiceIdentityAdmissionRules: {},
        kubernetesNamespaceAdmissionRules: {},
        kubernetesServiceAccountAdmissionRules: {},
        name: "projects/scribe-phase14/policy",
        updateTime: "2026-08-11T00:02:00Z",
      },
    ],
  ]);
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

const tokens: AccessTokenProvider = {
  getAccessToken(): Promise<string> {
    return Promise.resolve("bounded-readback-token-123");
  },
};

describe("Google controller control-plane read-back client", () => {
  it("performs two stable GET-only snapshots and returns verified evidence", async () => {
    const fixtures = responses();
    const calls: { readonly init: RequestInit | undefined; readonly url: string }[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      calls.push({ init, url });
      const value = fixtures.get(url);
      return Promise.resolve(
        value === undefined
          ? new Response("{}", { status: 404 })
          : new Response(JSON.stringify(value), {
              headers: { "Content-Type": "application/json; charset=utf-8" },
              status: 200,
            }),
      );
    };
    const client = new GoogleControllerControlPlaneReadbackClient(tokens, fakeFetch);

    const evidence = await client.readAndVerify(expectation);

    expect(evidence.projectId).toBe("scribe-phase14");
    expect(evidence.service.generation).toBe("1");
    expect(calls).toHaveLength(fixtures.size * 2);
    expect(new Set(calls.map(({ url }) => url))).toEqual(new Set(fixtures.keys()));
    for (const call of calls) {
      expect(call.init?.method).toBe("GET");
      expect(call.init?.body).toBeUndefined();
      expect(call.init?.redirect).toBe("manual");
      expect(new Headers(call.init?.headers).get("authorization")).toBe(
        "Bearer bounded-readback-token-123",
      );
      expect(new Headers(call.init?.headers).get("x-goog-user-project")).toBe("scribe-phase14");
      expect(call.url).not.toContain(":access");
    }
  });

  it("rejects resources that change between the bounded snapshots", async () => {
    const fixtures = responses();
    let serviceReads = 0;
    const fakeFetch: typeof fetch = (input) => {
      const url = requestUrl(input);
      const fixture = fixtures.get(url);
      if (fixture === undefined) return Promise.resolve(new Response("{}", { status: 404 }));
      if (url === urls.service) {
        serviceReads += 1;
        const service = structuredClone(fixture) as Record<string, unknown>;
        if (serviceReads === 2) service["etag"] = "changed-etag";
        return Promise.resolve(Response.json(service));
      }
      return Promise.resolve(Response.json(fixture));
    };
    const client = new GoogleControllerControlPlaneReadbackClient(tokens, fakeFetch);

    await expect(client.readAndVerify(expectation)).rejects.toThrow(
      "control-plane resources changed during read-back",
    );
  });

  it("fails safely on redirects, non-JSON, oversized bodies, and invalid tokens", async () => {
    const redirecting: typeof fetch = () =>
      Promise.resolve(
        new Response(null, { headers: { Location: "https://example.test/" }, status: 302 }),
      );
    await expect(
      new GoogleControllerControlPlaneReadbackClient(tokens, redirecting).readAndVerify(
        expectation,
      ),
    ).rejects.toThrow("control-plane read-back request failed");

    const nonJson: typeof fetch = () =>
      Promise.resolve(
        new Response("not json", { headers: { "Content-Type": "text/plain" }, status: 200 }),
      );
    await expect(
      new GoogleControllerControlPlaneReadbackClient(tokens, nonJson).readAndVerify(expectation),
    ).rejects.toThrow("control-plane read-back request failed");

    const oversized: typeof fetch = () =>
      Promise.resolve(
        new Response("{}", {
          headers: {
            "Content-Length": "262145",
            "Content-Type": "application/json",
          },
          status: 200,
        }),
      );
    await expect(
      new GoogleControllerControlPlaneReadbackClient(tokens, oversized).readAndVerify(expectation),
    ).rejects.toThrow("control-plane read-back request failed");

    const invalidTokens: AccessTokenProvider = {
      getAccessToken(): Promise<string> {
        return Promise.resolve("line\nbreak");
      },
    };
    const noNetwork: typeof fetch = () => Promise.reject(new Error("network must not be reached"));
    await expect(
      new GoogleControllerControlPlaneReadbackClient(invalidTokens, noNetwork).readAndVerify(
        expectation,
      ),
    ).rejects.toThrow("control-plane read-back authentication is unavailable");
  });

  it("aborts every bounded request at the fixed timeout", async () => {
    vi.useFakeTimers();
    try {
      const hanging: typeof fetch = (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      const verification = expect(
        new GoogleControllerControlPlaneReadbackClient(tokens, hanging).readAndVerify(expectation),
      ).rejects.toThrow("control-plane read-back request failed");

      await vi.advanceTimersByTimeAsync(10_000);
      await verification;
    } finally {
      vi.useRealTimers();
    }
  });
});
