import { describe, expect, it } from "vitest";

import { defaultSyntheticAuthorizations } from "./control-store.js";
import {
  verifyReleaseWorkloadIdentityReadback,
  type ReleaseWorkloadIdentityRawReadback,
} from "./release-workload-identity-readback.js";
import { createReleaseWorkloadIdentityPlan } from "./release-workload-identity.js";
import { createReleaseSupplyChainDeploymentPlan } from "./release-supply-chain.js";

function plan(): ReturnType<typeof createReleaseWorkloadIdentityPlan> {
  return createReleaseWorkloadIdentityPlan(
    createReleaseSupplyChainDeploymentPlan({
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
      projectNumber: "123456789012",
    }),
  );
}

function rawReadback(expected: ReturnType<typeof plan>): ReleaseWorkloadIdentityRawReadback {
  const publisher = expected.serviceAccounts[0];
  const signer = expected.serviceAccounts[1];
  return {
    pool: { ...expected.pool, state: "ACTIVE" },
    provider: {
      attributeCondition: expected.provider.attributeCondition,
      attributeMapping: expected.provider.attributeMapping,
      description: expected.provider.description,
      disabled: expected.provider.disabled,
      displayName: expected.provider.displayName,
      name: expected.provider.name,
      oidc: { issuerUri: expected.provider.oidc.issuerUri },
      state: "ACTIVE",
    },
    serviceAccounts: [
      {
        account: {
          ...publisher,
          disabled: false,
          oauth2ClientId: "900000000001",
          projectId: expected.projectId,
          uniqueId: "100000000001",
        },
        iamPolicy: {
          bindings: expected.permissions.publisher.bindings,
          etag: "publisher-policy-etag",
          version: 1,
        },
        userManagedKeys: {},
      },
      {
        account: {
          ...signer,
          disabled: false,
          oauth2ClientId: "900000000002",
          projectId: expected.projectId,
          uniqueId: "100000000002",
        },
        iamPolicy: {
          bindings: expected.permissions.signer.bindings,
          etag: "signer-policy-etag",
          version: 1,
        },
        userManagedKeys: { keys: [] },
      },
    ],
  };
}

describe("release workload identity read-back", () => {
  it("accepts one active GitHub provider, exact impersonation, and zero user-managed keys", () => {
    const expected = plan();

    expect(verifyReleaseWorkloadIdentityReadback(expected, rawReadback(expected))).toEqual({
      poolState: "ACTIVE",
      providerState: "ACTIVE",
      serviceAccounts: [
        {
          email: expected.serviceAccounts[0].email,
          iam: { etag: "publisher-policy-etag", version: 1 },
          uniqueId: "100000000001",
          userManagedKeyCount: 0,
        },
        {
          email: expected.serviceAccounts[1].email,
          iam: { etag: "signer-policy-etag", version: 1 },
          uniqueId: "100000000002",
          userManagedKeyCount: 0,
        },
      ],
    });
  });

  it("rejects broadened provider conditions, keys, IAM, and shared service-account identity", () => {
    const expected = plan();
    const broadProvider = structuredClone(rawReadback(expected));
    broadProvider.provider.attributeCondition = "assertion.repository_owner_id != ''";
    expect(() => verifyReleaseWorkloadIdentityReadback(expected, broadProvider)).toThrow(
      "release workload identity provider read-back drifted",
    );

    const customAudience = structuredClone(rawReadback(expected)) as unknown as {
      provider: { oidc: { allowedAudiences: string[] } };
    };
    customAudience.provider.oidc.allowedAudiences = ["https://example.test/untrusted"];
    expect(() => verifyReleaseWorkloadIdentityReadback(expected, customAudience)).toThrow();

    const withoutKeys = rawReadback(expected);
    const keyPresent = {
      ...withoutKeys,
      serviceAccounts: [
        withoutKeys.serviceAccounts[0],
        {
          ...withoutKeys.serviceAccounts[1],
          userManagedKeys: {
            keys: [{ name: "projects/scribe-phase14/serviceAccounts/signer/keys/unexpected" }],
          },
        },
      ],
    };
    expect(() => verifyReleaseWorkloadIdentityReadback(expected, keyPresent)).toThrow();

    const extraIam = structuredClone(rawReadback(expected));
    extraIam.serviceAccounts[0].iamPolicy.bindings?.push({
      members: [expected.principalSet],
      role: "roles/iam.serviceAccountTokenCreator",
    });
    expect(() => verifyReleaseWorkloadIdentityReadback(expected, extraIam)).toThrow();

    const shared = structuredClone(rawReadback(expected));
    shared.serviceAccounts[1].account.uniqueId = shared.serviceAccounts[0].account.uniqueId;
    expect(() => verifyReleaseWorkloadIdentityReadback(expected, shared)).toThrow(
      "publisher and signer service accounts must be distinct",
    );
  });
});
