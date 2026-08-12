import type { AccessTokenProvider } from "./cloud-run-client.js";
import {
  BoundedGoogleControlPlaneReadClient,
  type GoogleControlPlaneReadRequest,
} from "./google-control-plane-read.js";
import {
  verifyReleaseSupplyChainReadback,
  type ReleaseSupplyChainReadbackEvidence,
} from "./release-supply-chain-readback.js";
import {
  releaseSupplyChainDeploymentPlanSchema,
  type ReleaseSupplyChainDeploymentPlan,
} from "./release-supply-chain.js";

export type ReleaseSupplyChainReadbackKey =
  | "attestor"
  | "attestorIamPolicy"
  | "cryptoKey"
  | "cryptoKeyIamPolicy"
  | "cryptoKeyVersions"
  | "kmsPublicKey"
  | "note"
  | "noteIamPolicy"
  | "projectIamPolicy"
  | "repository0IamPolicy"
  | "repository1IamPolicy";

function requireSnapshotValue(
  snapshot: ReadonlyMap<ReleaseSupplyChainReadbackKey, unknown>,
  key: ReleaseSupplyChainReadbackKey,
): unknown {
  if (!snapshot.has(key)) throw new Error("release supply-chain snapshot is incomplete");
  return snapshot.get(key);
}

export function createReleaseSupplyChainReadbackRequests(
  expectation: ReleaseSupplyChainDeploymentPlan,
): readonly GoogleControlPlaneReadRequest<ReleaseSupplyChainReadbackKey>[] {
  const expected = releaseSupplyChainDeploymentPlanSchema.parse(expectation);
  const attestorUrl = `https://binaryauthorization.googleapis.com/v1/${expected.attestor.name}`;
  const noteUrl = `https://containeranalysis.googleapis.com/v1/${expected.artifactAnalysisNote.name}`;
  const cryptoKeyUrl = `https://cloudkms.googleapis.com/v1/${expected.kms.cryptoKey.name}`;
  const signingVersionUrl = `https://cloudkms.googleapis.com/v1/${expected.kms.signingVersion.name}`;
  const repositories = expected.permissions.repositories;
  return [
    { key: "attestor", method: "GET", url: attestorUrl },
    {
      key: "attestorIamPolicy",
      method: "GET",
      url: `${attestorUrl}:getIamPolicy?options.requestedPolicyVersion=3`,
    },
    { key: "note", method: "GET", url: noteUrl },
    {
      key: "noteIamPolicy",
      method: "GET",
      url: `${noteUrl}:getIamPolicy?options.requestedPolicyVersion=3`,
    },
    { key: "cryptoKey", method: "GET", url: cryptoKeyUrl },
    {
      key: "cryptoKeyVersions",
      method: "GET",
      url: `${cryptoKeyUrl}/cryptoKeyVersions?pageSize=2&view=FULL`,
    },
    { key: "kmsPublicKey", method: "GET", url: `${signingVersionUrl}/publicKey` },
    {
      key: "cryptoKeyIamPolicy",
      method: "GET",
      url: `${cryptoKeyUrl}:getIamPolicy?options.requestedPolicyVersion=3`,
    },
    {
      body: { options: { requestedPolicyVersion: 3 } },
      key: "projectIamPolicy",
      method: "POST_GET_IAM_POLICY",
      url: `https://cloudresourcemanager.googleapis.com/v1/projects/${expected.projectId}:getIamPolicy`,
    },
    ...repositories.map(
      ({ resource }, index): GoogleControlPlaneReadRequest<ReleaseSupplyChainReadbackKey> => ({
        key: index === 0 ? "repository0IamPolicy" : "repository1IamPolicy",
        method: "GET",
        url: `https://artifactregistry.googleapis.com/v1/${resource}:getIamPolicy?options.requestedPolicyVersion=3`,
      }),
    ),
  ];
}

export class GoogleReleaseSupplyChainReadbackClient {
  readonly #reads: BoundedGoogleControlPlaneReadClient;

  constructor(tokens: AccessTokenProvider, controlPlaneFetch: typeof fetch = fetch) {
    this.#reads = new BoundedGoogleControlPlaneReadClient(tokens, controlPlaneFetch);
  }

  async readAndVerify(
    expectation: ReleaseSupplyChainDeploymentPlan,
  ): Promise<ReleaseSupplyChainReadbackEvidence> {
    const expected = releaseSupplyChainDeploymentPlanSchema.parse(expectation);
    const snapshot = await this.#reads.stableSnapshot(
      expected.projectId,
      createReleaseSupplyChainReadbackRequests(expected),
    );
    return verifyReleaseSupplyChainReadback(expected, {
      attestor: requireSnapshotValue(snapshot, "attestor"),
      attestorIamPolicy: requireSnapshotValue(snapshot, "attestorIamPolicy"),
      cryptoKey: requireSnapshotValue(snapshot, "cryptoKey"),
      cryptoKeyIamPolicy: requireSnapshotValue(snapshot, "cryptoKeyIamPolicy"),
      cryptoKeyVersions: requireSnapshotValue(snapshot, "cryptoKeyVersions"),
      kmsPublicKey: requireSnapshotValue(snapshot, "kmsPublicKey"),
      note: requireSnapshotValue(snapshot, "note"),
      noteIamPolicy: requireSnapshotValue(snapshot, "noteIamPolicy"),
      projectIamPolicy: requireSnapshotValue(snapshot, "projectIamPolicy"),
      repositories: [
        {
          iamPolicy: requireSnapshotValue(snapshot, "repository0IamPolicy"),
          resource: expected.permissions.repositories[0].resource,
        },
        {
          iamPolicy: requireSnapshotValue(snapshot, "repository1IamPolicy"),
          resource: expected.permissions.repositories[1].resource,
        },
      ],
    });
  }
}
