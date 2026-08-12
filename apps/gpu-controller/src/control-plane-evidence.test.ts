import { describe, expect, it } from "vitest";

import {
  verifyControllerControlPlaneReadback,
  type ControllerControlPlaneReadbackExpectation,
} from "./control-plane-evidence.js";
import { defaultSyntheticAuthorizations } from "./control-store.js";
import { verifyControllerDeploymentReadback } from "./deployment-evidence.js";
import {
  createControllerFirestoreDeploymentPlan,
  type ControllerFirestoreRawReadback,
} from "./firestore-deployment.js";
import {
  createControllerIamDeploymentPlan,
  type ControllerIamRawReadback,
} from "./iam-deployment.js";
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
    secondaryHmacSecret: { name: "scribe-drop-staging-controller-secondary", version: "3" },
    serviceName: "scribe-drop-staging-gpu-controller",
  },
};

function secretObservation(name: string, version: string): Record<string, unknown> {
  const resource = `projects/${expectation.projectNumber}/secrets/${name}`;
  return {
    iamPolicy: {
      bindings: [
        {
          members: ["serviceAccount:gpu-controller@scribe-phase14.iam.gserviceaccount.com"],
          role: "roles/secretmanager.secretAccessor",
        },
      ],
      etag: `${name}-iam-etag`,
      version: 1,
    },
    secret: {
      annotations: {},
      createTime: "2026-08-11T00:00:00Z",
      etag: `${name}-etag`,
      labels: {
        "scribe-drop-component": "gpu-controller",
        "scribe-drop-environment": "staging",
      },
      name: resource,
      replication: { userManaged: { replicas: [{ location: "asia-southeast1" }] } },
      topics: [],
      versionAliases: {},
    },
    version: {
      clientSpecifiedPayloadChecksum: true,
      createTime: "2026-08-11T00:01:00Z",
      etag: `${name}-version-etag`,
      name: `${resource}/versions/${version}`,
      replicationStatus: {
        userManaged: { replicas: [{ location: "asia-southeast1" }] },
      },
      state: "ENABLED",
    },
  };
}

function rawControlPlaneReadback(): Record<string, unknown> {
  const plan = createControllerServiceDeploymentPlan(expectation.deployment);
  const revision = "scribe-drop-staging-gpu-controller-00001-abc";
  const uri = "https://scribe-drop-staging-gpu-controller-abcdef-as.a.run.app/";
  return {
    binaryAuthorizationPolicy: {
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
    primarySecret: secretObservation("scribe-drop-staging-controller-primary", "7"),
    secondarySecret: secretObservation("scribe-drop-staging-controller-secondary", "3"),
    service: {
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
          uri,
        },
      ],
      uid: "123e4567-e89b-42d3-a456-426614174000",
      updateTime: "2026-08-11T00:01:00Z",
      uri,
      urls: [uri],
    },
    serviceIamPolicy: { bindings: [], etag: "service-iam-etag", version: 1 },
  };
}

function rawIamReadback(): ControllerIamRawReadback {
  const plan = createControllerIamDeploymentPlan(expectation.deployment);
  return {
    artifactRepository: {
      iamPolicy: { bindings: plan.artifactRepository.bindings, etag: "repo-etag", version: 1 },
      resource: plan.artifactRepository.resource,
    },
    cloudRunRole: { ...plan.cloudRunRole, etag: "run-role-etag" },
    firestoreRole: { ...plan.firestoreRole, etag: "firestore-role-etag" },
    project: {
      iamPolicy: { bindings: plan.projectBindings, etag: "project-etag", version: 3 },
      resource: plan.projectResource,
    },
    runtimeServiceAccount: {
      iamPolicy: {
        bindings: plan.runtimeServiceAccount.bindings,
        etag: "runtime-etag",
        version: 1,
      },
      resource: plan.runtimeServiceAccount.resource,
    },
  };
}

function rawFirestoreReadback(): ControllerFirestoreRawReadback {
  const plan = createControllerFirestoreDeploymentPlan(expectation.deployment);
  const ancestorField = `${plan.database.name}/collectionGroups/__default__/fields/*`;
  const ttlFields: ControllerFirestoreRawReadback["ttlFields"] = [
    {
      indexConfig: { ancestorField, usesAncestorConfig: true },
      name: plan.ttlFields[0].name,
      ttlConfig: { state: "ACTIVE" },
    },
    {
      indexConfig: { ancestorField, usesAncestorConfig: true },
      name: plan.ttlFields[1].name,
      ttlConfig: { state: "ACTIVE" },
    },
  ];
  return {
    database: {
      ...plan.database,
      createTime: "2026-08-11T00:00:00Z",
      earliestVersionTime: "2026-08-11T12:00:00Z",
      etag: "database-etag",
      freeTier: false,
      keyPrefix: "",
      uid: "47e04f29-ac9a-4fe9-a988-e3f01d5944c4",
      updateTime: "2026-08-11T00:01:00Z",
      versionRetentionPeriod: "3600s",
    },
    ttlFields,
    ttlPolicies: { fields: [...ttlFields] },
  };
}

describe("atomic controller control-plane evidence", () => {
  it("verifies every required observation without returning secret payloads", () => {
    const evidence = verifyControllerControlPlaneReadback(expectation, rawControlPlaneReadback());

    expect(evidence.environment).toBe("staging");
    expect(evidence.projectId).toBe("scribe-phase14");
    expect(evidence.service.generation).toBe("1");
    expect(evidence.serviceIam.version).toBe(1);
    expect(evidence.primarySecret.versionEtag).toContain("primary-version-etag");
    expect(evidence.secondarySecret?.versionEtag).toContain("secondary-version-etag");
    expect(JSON.stringify(evidence)).not.toContain("payload");
  });

  it("rejects missing, excess, cross-project, and unknown observations", () => {
    const missingSecondary = rawControlPlaneReadback();
    delete missingSecondary["secondarySecret"];
    expect(() => verifyControllerControlPlaneReadback(expectation, missingSecondary)).toThrow();

    const withoutSecondary = structuredClone(expectation);
    delete withoutSecondary.deployment.secondaryHmacSecret;
    expect(() =>
      verifyControllerControlPlaneReadback(withoutSecondary, rawControlPlaneReadback()),
    ).toThrow();

    const crossProject = structuredClone(expectation);
    crossProject.binaryAuthorization.projectId = "scribe-other14";
    expect(() =>
      verifyControllerControlPlaneReadback(crossProject, rawControlPlaneReadback()),
    ).toThrow();

    const unknown = rawControlPlaneReadback();
    unknown["futureObservation"] = {};
    expect(() => verifyControllerControlPlaneReadback(expectation, unknown)).toThrow();
  });

  it("binds service security, IAM, and Firestore into one deployment evidence", () => {
    const evidence = verifyControllerDeploymentReadback(expectation, {
      controlPlane: rawControlPlaneReadback(),
      firestore: rawFirestoreReadback(),
      iam: rawIamReadback(),
    });

    expect(evidence.projectId).toBe("scribe-phase14");
    expect(evidence.environment).toBe("staging");
    expect(evidence.iam.project.version).toBe(3);
    expect(evidence.firestore.ttlStates).toEqual(["ACTIVE", "ACTIVE"]);
  });

  it("rejects a cross-resource deployment evidence mix", () => {
    const firestore = rawFirestoreReadback();
    firestore.database.name = "projects/scribe-other14/databases/scribe-staging-controller";
    expect(() =>
      verifyControllerDeploymentReadback(expectation, {
        controlPlane: rawControlPlaneReadback(),
        firestore,
        iam: rawIamReadback(),
      }),
    ).toThrow();

    const unknown = {
      controlPlane: rawControlPlaneReadback(),
      firestore: rawFirestoreReadback(),
      iam: rawIamReadback(),
      unrelatedProject: {},
    };
    expect(() => verifyControllerDeploymentReadback(expectation, unknown)).toThrow();
  });
});
