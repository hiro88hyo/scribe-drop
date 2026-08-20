import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { defaultSyntheticAuthorizations } from "./control-store.js";
import {
  candidateAttestationSnapshotFingerprint,
  createCandidateAttestationPayload,
  verifyCandidateAttestationOccurrenceLists,
  verifyCandidateAttestationReadback,
  type CandidateAttestationOccurrenceList,
} from "./candidate-attestation-readback.js";
import { createReleaseSupplyChainDeploymentPlan } from "./release-supply-chain.js";

function plan(): ReturnType<typeof createReleaseSupplyChainDeploymentPlan> {
  return createReleaseSupplyChainDeploymentPlan({
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
  });
}

function occurrenceList(
  expected: ReturnType<typeof plan>,
  index: 0 | 1,
  signature = Buffer.from(`signature-${String(index)}`, "utf8").toString("base64"),
): CandidateAttestationOccurrenceList {
  const image = expected.images[index];
  return {
    occurrences: [
      {
        attestation: {
          serializedPayload: Buffer.from(createCandidateAttestationPayload(image), "utf8").toString(
            "base64",
          ),
          signatures: [
            {
              publicKeyId: expected.attestor.userOwnedGrafeasNote.publicKeys[0].id,
              signature,
            },
          ],
        },
        createTime: `2026-08-12T00:00:0${String(index)}Z`,
        kind: "ATTESTATION",
        name: `projects/${expected.projectId}/occurrences/candidate-${String(index)}`,
        noteName: expected.artifactAnalysisNote.name,
        resourceUri: image,
        updateTime: `2026-08-12T00:00:0${String(index)}Z`,
      },
    ],
  };
}

describe("release candidate attestation read-back", () => {
  it("matches the pinned gcloud pretty JSON payload including its trailing newline", () => {
    const payload = createCandidateAttestationPayload(plan().images[0]);

    expect(payload).toContain('\n  "critical": {\n');
    expect(payload).toContain('\n      "docker-reference": ');
    expect(payload.endsWith("}\n")).toBe(true);
  });

  it("requires one canonical KMS-keyed attestation and VERIFIED result for both digests", () => {
    const expected = plan();
    const lists: [CandidateAttestationOccurrenceList, CandidateAttestationOccurrenceList] = [
      occurrenceList(expected, 0),
      occurrenceList(expected, 1),
    ];

    expect(verifyCandidateAttestationOccurrenceLists(expected, lists)).toHaveLength(2);
    expect(
      verifyCandidateAttestationReadback(expected, lists, [
        { result: "VERIFIED" },
        { denialReason: "", result: "VERIFIED" },
      ]),
    ).toEqual({
      attestations: [
        expect.objectContaining({
          resourceUri: expected.images[0],
          validationResult: "VERIFIED",
        }),
        expect.objectContaining({
          resourceUri: expected.images[1],
          validationResult: "VERIFIED",
        }),
      ],
    });
  });

  it("rejects payload, key, cardinality, pagination, and validation drift", () => {
    const expected = plan();
    const validLists: [CandidateAttestationOccurrenceList, CandidateAttestationOccurrenceList] = [
      occurrenceList(expected, 0),
      occurrenceList(expected, 1),
    ];
    const wrongPayload = structuredClone(validLists);
    wrongPayload[0].occurrences[0].attestation.serializedPayload = Buffer.from(
      createCandidateAttestationPayload(expected.images[1]),
      "utf8",
    ).toString("base64");
    expect(() => verifyCandidateAttestationOccurrenceLists(expected, wrongPayload)).toThrow(
      "release candidate attestation occurrence drifted",
    );

    const wrongKey = structuredClone(validLists);
    wrongKey[1].occurrences[0].attestation.signatures[0].publicKeyId = "kms://other-key";
    expect(() => verifyCandidateAttestationOccurrenceLists(expected, wrongKey)).toThrow(
      "release candidate attestation occurrence drifted",
    );

    const duplicate = structuredClone(validLists);
    duplicate[1].occurrences[0].name = duplicate[0].occurrences[0].name;
    expect(() => verifyCandidateAttestationOccurrenceLists(expected, duplicate)).toThrow(
      "release candidate attestation occurrences must be distinct",
    );

    const paginated = [{ ...validLists[0], nextPageToken: "more" }, validLists[1]];
    expect(() => verifyCandidateAttestationOccurrenceLists(expected, paginated)).toThrow();
    expect(() =>
      verifyCandidateAttestationReadback(expected, validLists, [
        { result: "VERIFIED" },
        { denialReason: "bad signature", result: "ATTESTATION_NOT_VERIFIABLE" },
      ]),
    ).toThrow();
  });

  it("fingerprints signature bytes so a mid-validation replacement is detected", () => {
    const expected = plan();
    const before: [CandidateAttestationOccurrenceList, CandidateAttestationOccurrenceList] = [
      occurrenceList(expected, 0),
      occurrenceList(expected, 1),
    ];
    const after: [CandidateAttestationOccurrenceList, CandidateAttestationOccurrenceList] = [
      occurrenceList(expected, 0, Buffer.from("replaced-signature", "utf8").toString("base64")),
      occurrenceList(expected, 1),
    ];

    expect(candidateAttestationSnapshotFingerprint(expected, before)).not.toBe(
      candidateAttestationSnapshotFingerprint(expected, after),
    );
  });
});
