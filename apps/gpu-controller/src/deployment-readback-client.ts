import type { AccessTokenProvider } from "./cloud-run-client.js";
import {
  controllerControlPlaneReadbackExpectationSchema,
  type ControllerControlPlaneReadbackExpectation,
} from "./control-plane-evidence.js";
import {
  createControllerControlPlaneReadbackRequests,
  type ControllerControlPlaneReadbackKey,
} from "./control-plane-readback-client.js";
import {
  verifyControllerDeploymentReadback,
  type ControllerDeploymentReadbackEvidence,
} from "./deployment-evidence.js";
import { createControllerFirestoreDeploymentPlan } from "./firestore-deployment.js";
import {
  controllerFirestoreStabilityProjection,
  createControllerFirestoreReadbackRequests,
  type ControllerFirestoreReadbackKey,
} from "./firestore-readback-client.js";
import {
  BoundedGoogleControlPlaneReadClient,
  type GoogleControlPlaneReadRequest,
} from "./google-control-plane-read.js";
import { createControllerIamDeploymentPlan } from "./iam-deployment.js";
import {
  createControllerIamReadbackRequests,
  type ControllerIamReadbackKey,
} from "./iam-readback-client.js";

type ControllerDeploymentReadbackKey =
  ControllerControlPlaneReadbackKey | ControllerFirestoreReadbackKey | ControllerIamReadbackKey;

function requireSnapshotValue(
  snapshot: ReadonlyMap<ControllerDeploymentReadbackKey, unknown>,
  key: ControllerDeploymentReadbackKey,
): unknown {
  if (!snapshot.has(key)) throw new Error("controller deployment snapshot is incomplete");
  return snapshot.get(key);
}

function stabilityProjection(key: ControllerDeploymentReadbackKey, value: unknown): unknown {
  if (
    key === "database" ||
    key === "requestTtl" ||
    key === "executionTtl" ||
    key === "ttlPolicies"
  ) {
    return controllerFirestoreStabilityProjection(key, value);
  }
  return value;
}

function deploymentReadbackRequests(
  expected: ControllerControlPlaneReadbackExpectation,
): readonly GoogleControlPlaneReadRequest<ControllerDeploymentReadbackKey>[] {
  const iamPlan = createControllerIamDeploymentPlan(expected.deployment);
  const firestorePlan = createControllerFirestoreDeploymentPlan(expected.deployment);
  return [
    ...createControllerControlPlaneReadbackRequests(expected),
    ...createControllerIamReadbackRequests(iamPlan),
    ...createControllerFirestoreReadbackRequests(firestorePlan),
  ];
}

export class GoogleControllerDeploymentReadbackClient {
  readonly #reads: BoundedGoogleControlPlaneReadClient;

  constructor(tokens: AccessTokenProvider, controlPlaneFetch: typeof fetch = fetch) {
    this.#reads = new BoundedGoogleControlPlaneReadClient(tokens, controlPlaneFetch);
  }

  async preflight(
    expectation: ControllerControlPlaneReadbackExpectation,
    options: { readonly allowMissingService?: boolean } = {},
  ): Promise<{ readonly requestCount: number }> {
    const expected = controllerControlPlaneReadbackExpectationSchema.parse(expectation);
    const requests = deploymentReadbackRequests(expected).filter(
      ({ key }) =>
        options.allowMissingService !== true || (key !== "service" && key !== "serviceIamPolicy"),
    );
    await this.#reads.stableSnapshot(
      expected.deployment.manifest.projectId,
      requests,
      stabilityProjection,
    );
    return { requestCount: requests.length };
  }

  async readAndVerify(
    expectation: ControllerControlPlaneReadbackExpectation,
  ): Promise<ControllerDeploymentReadbackEvidence> {
    const expected = controllerControlPlaneReadbackExpectationSchema.parse(expectation);
    const iamPlan = createControllerIamDeploymentPlan(expected.deployment);
    const requests = deploymentReadbackRequests(expected);
    const snapshot = await this.#reads.stableSnapshot(
      expected.deployment.manifest.projectId,
      requests,
      stabilityProjection,
    );
    const secondary = expected.deployment.secondaryHmacSecret;
    return verifyControllerDeploymentReadback(expected, {
      controlPlane: {
        binaryAuthorizationPolicy: requireSnapshotValue(snapshot, "binaryAuthorizationPolicy"),
        primarySecret: {
          iamPolicy: requireSnapshotValue(snapshot, "primarySecretIamPolicy"),
          secret: requireSnapshotValue(snapshot, "primarySecret"),
          version: requireSnapshotValue(snapshot, "primarySecretVersion"),
        },
        ...(secondary === undefined
          ? {}
          : {
              secondarySecret: {
                iamPolicy: requireSnapshotValue(snapshot, "secondarySecretIamPolicy"),
                secret: requireSnapshotValue(snapshot, "secondarySecret"),
                version: requireSnapshotValue(snapshot, "secondarySecretVersion"),
              },
            }),
        service: requireSnapshotValue(snapshot, "service"),
        serviceIamPolicy: requireSnapshotValue(snapshot, "serviceIamPolicy"),
      },
      firestore: {
        database: requireSnapshotValue(snapshot, "database"),
        ttlFields: [
          requireSnapshotValue(snapshot, "requestTtl"),
          requireSnapshotValue(snapshot, "executionTtl"),
        ],
        ttlPolicies: requireSnapshotValue(snapshot, "ttlPolicies"),
      },
      iam: {
        artifactRepository: {
          iamPolicy: requireSnapshotValue(snapshot, "artifactRepositoryIamPolicy"),
          resource: iamPlan.artifactRepository.resource,
        },
        cloudRunRole: requireSnapshotValue(snapshot, "cloudRunRole"),
        firestoreRole: requireSnapshotValue(snapshot, "firestoreRole"),
        project: {
          iamPolicy: requireSnapshotValue(snapshot, "projectIamPolicy"),
          resource: iamPlan.projectResource,
        },
        runtimeServiceAccount: {
          iamPolicy: requireSnapshotValue(snapshot, "runtimeServiceAccountIamPolicy"),
          resource: iamPlan.runtimeServiceAccount.resource,
        },
      },
    });
  }
}
