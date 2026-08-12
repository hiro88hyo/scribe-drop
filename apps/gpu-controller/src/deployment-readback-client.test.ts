import { describe, expect, it } from "vitest";

import type { AccessTokenProvider } from "./cloud-run-client.js";
import type { ControllerControlPlaneReadbackExpectation } from "./control-plane-evidence.js";
import { defaultSyntheticAuthorizations } from "./control-store.js";
import { GoogleControllerDeploymentReadbackClient } from "./deployment-readback-client.js";
import { createControllerFirestoreDeploymentPlan } from "./firestore-deployment.js";
import { createControllerIamDeploymentPlan } from "./iam-deployment.js";
import { createControllerServiceDeploymentPlan } from "./service-deployment.js";

const expectation: ControllerControlPlaneReadbackExpectation = {
  binaryAuthorization: {
    attestors: ["projects/scribe-phase14/attestors/release-candidate"],
    projectId: "scribe-phase14",
  },
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

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function fixtures(): Map<string, unknown> {
  const deployment = expectation.deployment;
  const servicePlan = createControllerServiceDeploymentPlan(deployment);
  const iamPlan = createControllerIamDeploymentPlan(deployment);
  const firestorePlan = createControllerFirestoreDeploymentPlan(deployment);
  const revision = "scribe-drop-staging-gpu-controller-00001-abc";
  const uri = "https://scribe-drop-staging-gpu-controller-abcdef-as.a.run.app/";
  const secretResource = `projects/scribe-phase14/secrets/${deployment.primaryHmacSecret.name}`;
  const defaultField = `${firestorePlan.database.name}/collectionGroups/__default__/fields/*`;
  const ttlFields = firestorePlan.ttlFields.map((field) => ({
    indexConfig: { ancestorField: defaultField, usesAncestorConfig: true },
    name: field.name,
    ttlConfig: { state: "ACTIVE" },
  }));
  const result = new Map<string, unknown>([
    [
      `https://run.googleapis.com/v2/${servicePlan.name}`,
      {
        binaryAuthorization: { useDefault: true },
        conditions: [{ state: "CONDITION_SUCCEEDED", type: "Ready" }],
        createTime: "2026-08-11T00:00:00Z",
        etag: "service-etag",
        generation: "1",
        ingress: servicePlan.ingress,
        invokerIamDisabled: true,
        labels: servicePlan.labels,
        latestCreatedRevision: revision,
        latestReadyRevision: revision,
        launchStage: "GA",
        name: servicePlan.name,
        observedGeneration: "1",
        reconciling: false,
        scaling: servicePlan.scaling,
        template: {
          containers: servicePlan.template.containers,
          executionEnvironment: servicePlan.template.executionEnvironment,
          healthCheckDisabled: false,
          labels: servicePlan.template.labels,
          maxInstanceRequestConcurrency: servicePlan.template.maxInstanceRequestConcurrency,
          scaling: servicePlan.template.scaling,
          serviceAccount: servicePlan.template.serviceAccount,
          sessionAffinity: false,
          timeout: servicePlan.template.timeout,
          volumes: [],
        },
        terminalCondition: { state: "CONDITION_SUCCEEDED", type: "Ready" },
        traffic: servicePlan.traffic,
        trafficStatuses: [
          {
            percent: 100,
            revision,
            type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST",
            uri,
          },
        ],
        uid: "123e4567-e89b-42d3-a456-426614174000",
        updateTime: "2026-08-11T00:01:00Z",
        uri,
        urls: [uri],
      },
    ],
    [
      `https://run.googleapis.com/v2/${servicePlan.name}:getIamPolicy?options.requestedPolicyVersion=3`,
      { bindings: [], etag: "service-iam-etag", version: 1 },
    ],
    [
      `https://secretmanager.googleapis.com/v1/${secretResource}`,
      {
        createTime: "2026-08-11T00:00:00Z",
        etag: "secret-etag",
        labels: {
          "scribe-drop-component": "gpu-controller",
          "scribe-drop-environment": "staging",
        },
        name: secretResource,
        replication: { userManaged: { replicas: [{ location: "asia-southeast1" }] } },
        topics: [],
      },
    ],
    [
      `https://secretmanager.googleapis.com/v1/${secretResource}/versions/7`,
      {
        clientSpecifiedPayloadChecksum: true,
        createTime: "2026-08-11T00:01:00Z",
        etag: "secret-version-etag",
        name: `${secretResource}/versions/7`,
        replicationStatus: {
          userManaged: { replicas: [{ location: "asia-southeast1" }] },
        },
        state: "ENABLED",
      },
    ],
    [
      `https://secretmanager.googleapis.com/v1/${secretResource}:getIamPolicy?options.requestedPolicyVersion=3`,
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
      "https://binaryauthorization.googleapis.com/v1/projects/scribe-phase14/policy",
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
    [
      `https://iam.googleapis.com/v1/${iamPlan.cloudRunRole.name}`,
      { ...iamPlan.cloudRunRole, etag: "run-role-etag" },
    ],
    [
      `https://iam.googleapis.com/v1/${iamPlan.firestoreRole.name}`,
      { ...iamPlan.firestoreRole, etag: "firestore-role-etag" },
    ],
    [
      `https://cloudresourcemanager.googleapis.com/v1/${iamPlan.projectResource}:getIamPolicy`,
      { bindings: iamPlan.projectBindings, etag: "project-iam-etag", version: 3 },
    ],
    [
      `https://artifactregistry.googleapis.com/v1/${iamPlan.artifactRepository.resource}:getIamPolicy?options.requestedPolicyVersion=3`,
      { bindings: iamPlan.artifactRepository.bindings, etag: "repo-iam-etag", version: 1 },
    ],
    [
      `https://iam.googleapis.com/v1/${iamPlan.runtimeServiceAccount.resource}:getIamPolicy?options.requestedPolicyVersion=3`,
      {
        bindings: iamPlan.runtimeServiceAccount.bindings,
        etag: "runtime-iam-etag",
        version: 1,
      },
    ],
    [
      `https://firestore.googleapis.com/v1/${firestorePlan.database.name}`,
      {
        ...firestorePlan.database,
        createTime: "2026-08-11T00:00:00Z",
        earliestVersionTime: "2026-08-11T12:00:00Z",
        etag: "database-etag",
        freeTier: false,
        uid: "17d78255-ce93-469a-933f-9fd1ab53b260",
        updateTime: "2026-08-11T00:01:00Z",
        versionRetentionPeriod: "3600s",
      },
    ],
    [
      `https://firestore.googleapis.com/v1/${firestorePlan.database.name}/collectionGroups/-/fields?filter=ttlConfig%3A*&pageSize=3`,
      { fields: [...ttlFields].reverse() },
    ],
    ...firestorePlan.ttlFields.map(
      (field, index) =>
        [`https://firestore.googleapis.com/v1/${field.name}`, ttlFields[index]] as const,
    ),
  ]);
  return result;
}

describe("Google controller deployment read-back client", () => {
  it("uses one token and one double-snapshot window for every deployment resource", async () => {
    const responses = fixtures();
    let tokenRequests = 0;
    const tokens: AccessTokenProvider = {
      getAccessToken(): Promise<string> {
        tokenRequests += 1;
        return Promise.resolve("atomic-deployment-readback-token");
      },
    };
    const readCounts = new Map<string, number>();
    const calls: { readonly init: RequestInit | undefined; readonly url: string }[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      calls.push({ init, url });
      const priorReads = readCounts.get(url) ?? 0;
      readCounts.set(url, priorReads + 1);
      const fixture = structuredClone(responses.get(url));
      if (
        url.includes("firestore.googleapis.com/v1/projects/") &&
        url.endsWith("/databases/scribe-staging-controller") &&
        fixture !== null &&
        typeof fixture === "object"
      ) {
        Object.assign(fixture, {
          earliestVersionTime: priorReads === 0 ? "2026-08-11T12:00:00Z" : "2026-08-11T12:00:01Z",
        });
      }
      if (
        url.includes("/collectionGroups/-/fields?") &&
        priorReads > 0 &&
        fixture !== null &&
        typeof fixture === "object" &&
        "fields" in fixture &&
        Array.isArray(fixture.fields)
      ) {
        fixture.fields.reverse();
      }
      return Promise.resolve(
        fixture === undefined
          ? new Response("{}", { status: 404 })
          : Response.json(fixture, { status: 200 }),
      );
    };

    const evidence = await new GoogleControllerDeploymentReadbackClient(
      tokens,
      fakeFetch,
    ).readAndVerify(expectation);

    expect(tokenRequests).toBe(1);
    expect(calls).toHaveLength(responses.size * 2);
    expect(new Set(calls.map(({ url }) => url))).toEqual(new Set(responses.keys()));
    expect(evidence.projectId).toBe("scribe-phase14");
    expect(evidence.iam.project.version).toBe(3);
    expect(evidence.firestore.ttlStates).toEqual(["ACTIVE", "ACTIVE"]);
    for (const call of calls) {
      expect(call.url).not.toContain("setIamPolicy");
      expect(new Headers(call.init?.headers).get("authorization")).toBe(
        "Bearer atomic-deployment-readback-token",
      );
      expect(new Headers(call.init?.headers).get("x-goog-user-project")).toBe("scribe-phase14");
    }
  });

  it("rejects meaningful cross-snapshot drift before producing evidence", async () => {
    const responses = fixtures();
    const iamPlan = createControllerIamDeploymentPlan(expectation.deployment);
    const roleUrl = `https://iam.googleapis.com/v1/${iamPlan.cloudRunRole.name}`;
    let roleReads = 0;
    const tokens: AccessTokenProvider = {
      getAccessToken(): Promise<string> {
        return Promise.resolve("atomic-deployment-readback-token");
      },
    };
    const fakeFetch: typeof fetch = (input) => {
      const url = requestUrl(input);
      const fixture = structuredClone(responses.get(url));
      if (url === roleUrl && fixture !== null && typeof fixture === "object" && roleReads++ > 0) {
        Object.assign(fixture, {
          includedPermissions: [...iamPlan.cloudRunRole.includedPermissions, "run.jobs.update"],
        });
      }
      return Promise.resolve(Response.json(fixture));
    };

    await expect(
      new GoogleControllerDeploymentReadbackClient(tokens, fakeFetch).readAndVerify(expectation),
    ).rejects.toThrow("control-plane resources changed during read-back");
  });
});
