import type { AccessTokenProvider } from "./cloud-run-client.js";
import {
  BoundedGoogleControlPlaneReadClient,
  type GoogleControlPlaneReadRequest,
} from "./google-control-plane-read.js";
import {
  controllerIamDeploymentPlanSchema,
  verifyControllerIamReadback,
  type ControllerIamDeploymentPlan,
  type ControllerIamReadbackEvidence,
} from "./iam-deployment.js";

export type ControllerIamReadbackKey =
  | "artifactRepositoryIamPolicy"
  | "cloudRunRole"
  | "firestoreRole"
  | "projectIamPolicy"
  | "runtimeServiceAccountIamPolicy";

function requireSnapshotValue(
  snapshot: ReadonlyMap<ControllerIamReadbackKey, unknown>,
  key: ControllerIamReadbackKey,
): unknown {
  if (!snapshot.has(key)) throw new Error("controller IAM read-back snapshot is incomplete");
  return snapshot.get(key);
}

export function createControllerIamReadbackRequests(
  plan: ControllerIamDeploymentPlan,
): readonly GoogleControlPlaneReadRequest<ControllerIamReadbackKey>[] {
  const expected = controllerIamDeploymentPlanSchema.parse(plan);
  return [
    {
      key: "cloudRunRole",
      method: "GET",
      url: `https://iam.googleapis.com/v1/${expected.cloudRunRole.name}`,
    },
    {
      key: "firestoreRole",
      method: "GET",
      url: `https://iam.googleapis.com/v1/${expected.firestoreRole.name}`,
    },
    {
      body: { options: { requestedPolicyVersion: 3 } },
      key: "projectIamPolicy",
      method: "POST_GET_IAM_POLICY",
      url: `https://cloudresourcemanager.googleapis.com/v1/${expected.projectResource}:getIamPolicy`,
    },
    {
      key: "artifactRepositoryIamPolicy",
      method: "GET",
      url: `https://artifactregistry.googleapis.com/v1/${expected.artifactRepository.resource}:getIamPolicy?options.requestedPolicyVersion=3`,
    },
    {
      key: "runtimeServiceAccountIamPolicy",
      method: "POST_GET_IAM_POLICY",
      url: `https://iam.googleapis.com/v1/${expected.runtimeServiceAccount.resource}:getIamPolicy?options.requestedPolicyVersion=3`,
    },
  ];
}

export class GoogleControllerIamReadbackClient {
  readonly #reads: BoundedGoogleControlPlaneReadClient;

  constructor(tokens: AccessTokenProvider, controlPlaneFetch: typeof fetch = fetch) {
    this.#reads = new BoundedGoogleControlPlaneReadClient(tokens, controlPlaneFetch);
  }

  async readAndVerify(plan: ControllerIamDeploymentPlan): Promise<ControllerIamReadbackEvidence> {
    const expected = controllerIamDeploymentPlanSchema.parse(plan);
    const projectId = expected.projectResource.slice("projects/".length);
    const requests = createControllerIamReadbackRequests(expected);
    const snapshot = await this.#reads.stableSnapshot(projectId, requests);
    return verifyControllerIamReadback(expected, {
      artifactRepository: {
        iamPolicy: requireSnapshotValue(snapshot, "artifactRepositoryIamPolicy"),
        resource: expected.artifactRepository.resource,
      },
      cloudRunRole: requireSnapshotValue(snapshot, "cloudRunRole"),
      firestoreRole: requireSnapshotValue(snapshot, "firestoreRole"),
      project: {
        iamPolicy: requireSnapshotValue(snapshot, "projectIamPolicy"),
        resource: expected.projectResource,
      },
      runtimeServiceAccount: {
        iamPolicy: requireSnapshotValue(snapshot, "runtimeServiceAccountIamPolicy"),
        resource: expected.runtimeServiceAccount.resource,
      },
    });
  }
}
