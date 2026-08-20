import type { AccessTokenProvider } from "./cloud-run-client.js";
import {
  BoundedGoogleControlPlaneReadClient,
  type GoogleControlPlaneReadRequest,
} from "./google-control-plane-read.js";
import {
  candidateAttestationSnapshotFingerprint,
  verifyCandidateAttestationOccurrenceLists,
  verifyCandidateAttestationReadback,
  type CandidateAttestationOccurrence,
  type CandidateAttestationReadbackEvidence,
} from "./candidate-attestation-readback.js";
import {
  releaseSupplyChainDeploymentPlanSchema,
  type ReleaseSupplyChainDeploymentPlan,
} from "./release-supply-chain.js";

export type CandidateAttestationListReadbackKey = "controllerOccurrences" | "workerOccurrences";
export type CandidateAttestationValidationReadbackKey = "controllerValidation" | "workerValidation";

function requireSnapshotValue<Key extends string>(
  snapshot: ReadonlyMap<Key, unknown>,
  key: Key,
): unknown {
  if (!snapshot.has(key)) throw new Error("candidate attestation snapshot is incomplete");
  return snapshot.get(key);
}

function occurrenceFilter(image: string): string {
  return `resourceUrl="${image}"`;
}

function occurrenceListRequest(
  expected: ReleaseSupplyChainDeploymentPlan,
  key: CandidateAttestationListReadbackKey,
  image: string,
): GoogleControlPlaneReadRequest<CandidateAttestationListReadbackKey> {
  const query = new URLSearchParams({
    filter: occurrenceFilter(image),
    pageSize: "2",
  });
  return {
    key,
    method: "GET",
    url: `https://containeranalysis.googleapis.com/v1/${expected.artifactAnalysisNote.name}/occurrences?${query.toString()}`,
  };
}

export function createCandidateAttestationListReadbackRequests(
  expectation: ReleaseSupplyChainDeploymentPlan,
): readonly GoogleControlPlaneReadRequest<CandidateAttestationListReadbackKey>[] {
  const expected = releaseSupplyChainDeploymentPlanSchema.parse(expectation);
  return [
    occurrenceListRequest(expected, "controllerOccurrences", expected.images[0]),
    occurrenceListRequest(expected, "workerOccurrences", expected.images[1]),
  ];
}

function validationRequest(
  expected: ReleaseSupplyChainDeploymentPlan,
  key: CandidateAttestationValidationReadbackKey,
  occurrence: CandidateAttestationOccurrence,
): GoogleControlPlaneReadRequest<CandidateAttestationValidationReadbackKey> {
  return {
    body: {
      attestation: occurrence.attestation,
      occurrenceNote: occurrence.noteName,
      occurrenceResourceUri: occurrence.resourceUri,
    },
    key,
    method: "POST_VALIDATE_ATTESTATION",
    url: `https://binaryauthorization.googleapis.com/v1/${expected.attestor.name}:validateAttestationOccurrence`,
  };
}

export function createCandidateAttestationValidationReadbackRequests(
  expectation: ReleaseSupplyChainDeploymentPlan,
  occurrences: readonly [CandidateAttestationOccurrence, CandidateAttestationOccurrence],
): readonly GoogleControlPlaneReadRequest<CandidateAttestationValidationReadbackKey>[] {
  const expected = releaseSupplyChainDeploymentPlanSchema.parse(expectation);
  return [
    validationRequest(expected, "controllerValidation", occurrences[0]),
    validationRequest(expected, "workerValidation", occurrences[1]),
  ];
}

function occurrenceLists(
  snapshot: ReadonlyMap<CandidateAttestationListReadbackKey, unknown>,
): readonly [unknown, unknown] {
  return [
    requireSnapshotValue(snapshot, "controllerOccurrences"),
    requireSnapshotValue(snapshot, "workerOccurrences"),
  ];
}

export class GoogleCandidateAttestationReadbackClient {
  readonly #reads: BoundedGoogleControlPlaneReadClient;

  constructor(tokens: AccessTokenProvider, controlPlaneFetch: typeof fetch = fetch) {
    this.#reads = new BoundedGoogleControlPlaneReadClient(tokens, controlPlaneFetch);
  }

  async readAndVerify(
    expectation: ReleaseSupplyChainDeploymentPlan,
  ): Promise<CandidateAttestationReadbackEvidence> {
    const expected = releaseSupplyChainDeploymentPlanSchema.parse(expectation);
    const listRequests = createCandidateAttestationListReadbackRequests(expected);
    const before = occurrenceLists(
      await this.#reads.stableSnapshot(expected.projectId, listRequests),
    );
    const beforeFingerprint = candidateAttestationSnapshotFingerprint(expected, before);
    const occurrences = verifyCandidateAttestationOccurrenceLists(expected, before);
    const validationRequests = createCandidateAttestationValidationReadbackRequests(
      expected,
      occurrences,
    );
    const validationSnapshot = await this.#reads.stableSnapshot(
      expected.projectId,
      validationRequests,
    );
    const validations = [
      requireSnapshotValue(validationSnapshot, "controllerValidation"),
      requireSnapshotValue(validationSnapshot, "workerValidation"),
    ] as const;
    const after = occurrenceLists(
      await this.#reads.stableSnapshot(expected.projectId, listRequests),
    );
    if (candidateAttestationSnapshotFingerprint(expected, after) !== beforeFingerprint) {
      throw new Error("candidate attestations changed during validation");
    }
    return verifyCandidateAttestationReadback(expected, after, validations);
  }
}
