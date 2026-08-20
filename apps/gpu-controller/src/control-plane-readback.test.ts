import { describe, expect, it } from "vitest";

import {
  verifyBinaryAuthorizationPolicyReadback,
  verifyControllerSecretReadback,
  verifyControllerServiceIamReadback,
  verifyIamPrincipalBindingsReadback,
  verifyIamPolicyBindingsReadback,
} from "./control-plane-readback.js";

describe("controller control-plane read-back", () => {
  it("requires an empty resource policy for the IAM-disabled public-HMAC Service", () => {
    expect(verifyControllerServiceIamReadback({ bindings: [], etag: "BwY=", version: 1 })).toEqual({
      etag: "BwY=",
      version: 1,
    });
    expect(() =>
      verifyControllerServiceIamReadback({
        bindings: [{ members: ["allUsers"], role: "roles/run.invoker" }],
        version: 1,
      }),
    ).toThrow();
    expect(() =>
      verifyControllerServiceIamReadback({ bindings: [], futurePolicyField: true }),
    ).toThrow();
  });

  it("compares least-authority IAM bindings independent of response ordering", () => {
    const expected = [
      {
        members: [
          "serviceAccount:gpu-controller@scribe-phase14.iam.gserviceaccount.com",
          "serviceAccount:gpu-controller-rotation@scribe-phase14.iam.gserviceaccount.com",
        ],
        role: "projects/scribe-phase14/roles/scribeDropGpuController",
      },
      {
        members: ["serviceAccount:gpu-controller@scribe-phase14.iam.gserviceaccount.com"],
        role: "roles/datastore.user",
      },
    ];
    const firstExpected = expected[0];
    const secondExpected = expected[1];
    if (firstExpected === undefined || secondExpected === undefined) {
      throw new Error("IAM expectation fixture is incomplete");
    }
    const observed = {
      bindings: [
        secondExpected,
        { ...firstExpected, members: [...firstExpected.members].reverse() },
      ],
      etag: "BwY=",
      version: 3,
    };
    expect(() => verifyIamPolicyBindingsReadback(expected, observed)).not.toThrow();

    const excess = structuredClone(observed);
    excess.bindings.push({
      members: ["serviceAccount:gpu-controller@scribe-phase14.iam.gserviceaccount.com"],
      role: "roles/owner",
    });
    expect(() => verifyIamPolicyBindingsReadback(expected, excess)).toThrow();
  });

  it("compares only the controller principal within a shared IAM role binding", () => {
    const principal = "serviceAccount:gpu-controller@scribe-phase14.iam.gserviceaccount.com";
    const expected = [{ members: [principal], role: "roles/artifactregistry.reader" }];
    expect(() =>
      verifyIamPrincipalBindingsReadback(principal, expected, {
        bindings: [
          {
            members: [
              principal,
              "serviceAccount:gpu-controller-production@scribe-phase14.iam.gserviceaccount.com",
            ],
            role: "roles/artifactregistry.reader",
          },
        ],
        etag: "BwY=",
        version: 1,
      }),
    ).not.toThrow();
    expect(() =>
      verifyIamPrincipalBindingsReadback(principal, expected, {
        bindings: [
          { members: [principal], role: "roles/artifactregistry.reader" },
          { members: [principal], role: "roles/owner" },
        ],
        etag: "BwY=",
        version: 1,
      }),
    ).toThrow("controller principal IAM bindings exceed the expected policy");
  });

  it("requires a fixed enabled Singapore secret version and exact accessor policy", () => {
    const expectation = {
      controllerServiceAccount: "gpu-controller@scribe-phase14.iam.gserviceaccount.com",
      environment: "staging" as const,
      name: "scribe-drop-staging-controller-primary",
      projectId: "scribe-phase14",
      projectNumber: "123456789012",
      version: "7",
    };
    const secret = {
      annotations: {},
      createTime: "2026-08-11T00:00:00Z",
      etag: "secret-etag",
      labels: {
        "scribe-drop-component": "gpu-controller",
        "scribe-drop-environment": "staging",
      },
      name: "projects/123456789012/secrets/scribe-drop-staging-controller-primary",
      replication: { userManaged: { replicas: [{ location: "asia-southeast1" }] } },
      topics: [],
      versionAliases: {},
    };
    const version = {
      clientSpecifiedPayloadChecksum: true,
      createTime: "2026-08-11T00:01:00Z",
      etag: "version-etag",
      name: "projects/123456789012/secrets/scribe-drop-staging-controller-primary/versions/7",
      replicationStatus: {
        userManaged: { replicas: [{ location: "asia-southeast1" }] },
      },
      state: "ENABLED",
    };
    const iam = {
      bindings: [
        {
          members: ["serviceAccount:gpu-controller@scribe-phase14.iam.gserviceaccount.com"],
          role: "roles/secretmanager.secretAccessor",
        },
      ],
      etag: "iam-etag",
      version: 1,
    };
    expect(verifyControllerSecretReadback(expectation, secret, version, iam)).toEqual({
      secretCreateTime: "2026-08-11T00:00:00Z",
      secretEtag: "secret-etag",
      secretIam: { etag: "iam-etag", version: 1 },
      versionCreateTime: "2026-08-11T00:01:00Z",
      versionEtag: "version-etag",
    });

    expect(() =>
      verifyControllerSecretReadback(
        expectation,
        secret,
        { ...version, name: version.name.replace("/7", "/8") },
        iam,
      ),
    ).toThrow();
    expect(() =>
      verifyControllerSecretReadback(expectation, secret, { ...version, state: "DISABLED" }, iam),
    ).toThrow();
    expect(() =>
      verifyControllerSecretReadback(
        expectation,
        secret,
        { ...version, clientSpecifiedPayloadChecksum: false },
        iam,
      ),
    ).toThrow();
    expect(() =>
      verifyControllerSecretReadback(
        expectation,
        { ...secret, versionAliases: { current: "7" } },
        version,
        iam,
      ),
    ).toThrow();
  });

  it("requires the project Binary Authorization policy to enforce exact attestations", () => {
    const expectation = {
      attestors: ["projects/scribe-phase14/attestors/release-candidate"],
      projectId: "scribe-phase14",
    };
    const policy = {
      admissionWhitelistPatterns: [],
      clusterAdmissionRules: {},
      defaultAdmissionRule: {
        enforcementMode: "ENFORCED_BLOCK_AND_AUDIT_LOG",
        evaluationMode: "REQUIRE_ATTESTATION",
        requireAttestationsBy: expectation.attestors,
      },
      etag: "binauth-etag",
      globalPolicyEvaluationMode: "ENABLE",
      istioServiceIdentityAdmissionRules: {},
      kubernetesNamespaceAdmissionRules: {},
      kubernetesServiceAccountAdmissionRules: {},
      name: "projects/scribe-phase14/policy",
      updateTime: "2026-08-11T00:02:00Z",
    };
    expect(verifyBinaryAuthorizationPolicyReadback(expectation, policy)).toEqual({
      etag: "binauth-etag",
      updateTime: "2026-08-11T00:02:00Z",
    });

    expect(() =>
      verifyBinaryAuthorizationPolicyReadback(expectation, {
        ...policy,
        defaultAdmissionRule: { ...policy.defaultAdmissionRule, evaluationMode: "ALWAYS_ALLOW" },
      }),
    ).toThrow();
    expect(() =>
      verifyBinaryAuthorizationPolicyReadback(expectation, {
        ...policy,
        admissionWhitelistPatterns: [{ namePattern: "gcr.io/example/**" }],
      }),
    ).toThrow();
    expect(() =>
      verifyBinaryAuthorizationPolicyReadback(expectation, {
        ...policy,
        futurePolicyField: true,
      }),
    ).toThrow();
  });
});
