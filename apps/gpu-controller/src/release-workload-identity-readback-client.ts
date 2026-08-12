import type { AccessTokenProvider } from "./cloud-run-client.js";
import {
  BoundedGoogleControlPlaneReadClient,
  type GoogleControlPlaneReadRequest,
} from "./google-control-plane-read.js";
import {
  verifyReleaseWorkloadIdentityReadback,
  type ReleaseWorkloadIdentityReadbackEvidence,
} from "./release-workload-identity-readback.js";
import {
  releaseWorkloadIdentityPlanSchema,
  type ReleaseWorkloadIdentityPlan,
} from "./release-workload-identity.js";

export type ReleaseWorkloadIdentityReadbackKey =
  | "pool"
  | "provider"
  | "publisherAccount"
  | "publisherIamPolicy"
  | "publisherUserManagedKeys"
  | "signerAccount"
  | "signerIamPolicy"
  | "signerUserManagedKeys";

function requireSnapshotValue(
  snapshot: ReadonlyMap<ReleaseWorkloadIdentityReadbackKey, unknown>,
  key: ReleaseWorkloadIdentityReadbackKey,
): unknown {
  if (!snapshot.has(key)) throw new Error("release workload identity snapshot is incomplete");
  return snapshot.get(key);
}

function serviceAccountRequests(
  projectId: string,
  email: string,
  accountKey: "publisherAccount" | "signerAccount",
  keysKey: "publisherUserManagedKeys" | "signerUserManagedKeys",
  policyKey: "publisherIamPolicy" | "signerIamPolicy",
): readonly GoogleControlPlaneReadRequest<ReleaseWorkloadIdentityReadbackKey>[] {
  const url = `https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts/${email}`;
  return [
    { key: accountKey, method: "GET", url },
    { key: keysKey, method: "GET", url: `${url}/keys?keyTypes=USER_MANAGED` },
    {
      body: { options: { requestedPolicyVersion: 3 } },
      key: policyKey,
      method: "POST_GET_IAM_POLICY",
      url: `${url}:getIamPolicy`,
    },
  ];
}

export function createReleaseWorkloadIdentityReadbackRequests(
  expectation: ReleaseWorkloadIdentityPlan,
): readonly GoogleControlPlaneReadRequest<ReleaseWorkloadIdentityReadbackKey>[] {
  const expected = releaseWorkloadIdentityPlanSchema.parse(expectation);
  return [
    {
      key: "pool",
      method: "GET",
      url: `https://iam.googleapis.com/v1/${expected.pool.name}`,
    },
    {
      key: "provider",
      method: "GET",
      url: `https://iam.googleapis.com/v1/${expected.provider.name}`,
    },
    ...serviceAccountRequests(
      expected.projectId,
      expected.serviceAccounts[0].email,
      "publisherAccount",
      "publisherUserManagedKeys",
      "publisherIamPolicy",
    ),
    ...serviceAccountRequests(
      expected.projectId,
      expected.serviceAccounts[1].email,
      "signerAccount",
      "signerUserManagedKeys",
      "signerIamPolicy",
    ),
  ];
}

export class GoogleReleaseWorkloadIdentityReadbackClient {
  readonly #reads: BoundedGoogleControlPlaneReadClient;

  constructor(tokens: AccessTokenProvider, controlPlaneFetch: typeof fetch = fetch) {
    this.#reads = new BoundedGoogleControlPlaneReadClient(tokens, controlPlaneFetch);
  }

  async readAndVerify(
    expectation: ReleaseWorkloadIdentityPlan,
  ): Promise<ReleaseWorkloadIdentityReadbackEvidence> {
    const expected = releaseWorkloadIdentityPlanSchema.parse(expectation);
    const snapshot = await this.#reads.stableSnapshot(
      expected.projectId,
      createReleaseWorkloadIdentityReadbackRequests(expected),
    );
    return verifyReleaseWorkloadIdentityReadback(expected, {
      pool: requireSnapshotValue(snapshot, "pool"),
      provider: requireSnapshotValue(snapshot, "provider"),
      serviceAccounts: [
        {
          account: requireSnapshotValue(snapshot, "publisherAccount"),
          iamPolicy: requireSnapshotValue(snapshot, "publisherIamPolicy"),
          userManagedKeys: requireSnapshotValue(snapshot, "publisherUserManagedKeys"),
        },
        {
          account: requireSnapshotValue(snapshot, "signerAccount"),
          iamPolicy: requireSnapshotValue(snapshot, "signerIamPolicy"),
          userManagedKeys: requireSnapshotValue(snapshot, "signerUserManagedKeys"),
        },
      ],
    });
  }
}
