import { Buffer } from "node:buffer";

import { z } from "zod";

import { binaryAuthorizationAttestationSchema } from "./google-control-plane-read.js";
import {
  releaseSupplyChainDeploymentPlanSchema,
  type ReleaseSupplyChainDeploymentPlan,
} from "./release-supply-chain.js";

const timestampSchema = z.iso.datetime({ offset: true });
const digestImageSchema = z
  .string()
  .regex(
    /^asia-southeast1-docker\.pkg\.dev\/[a-z][a-z0-9-]{4,28}\/[a-z0-9._-]+\/[a-z0-9._-]+@sha256:[a-f0-9]{64}$/u,
  );

export const candidateAttestationOccurrenceSchema = z
  .object({
    attestation: binaryAuthorizationAttestationSchema,
    createTime: timestampSchema,
    envelope: z.never().optional(),
    kind: z.literal("ATTESTATION"),
    name: z.string().min(1).max(1024),
    noteName: z.string().min(1).max(1024),
    remediation: z.literal("").optional(),
    resourceUri: digestImageSchema,
    updateTime: timestampSchema,
  })
  .strict();

export const candidateAttestationOccurrenceListSchema = z
  .object({
    nextPageToken: z.never().optional(),
    occurrences: z.tuple([candidateAttestationOccurrenceSchema]),
    unreachable: z.never().optional(),
  })
  .strict();

export const candidateAttestationOccurrenceListsSchema = z.tuple([
  candidateAttestationOccurrenceListSchema,
  candidateAttestationOccurrenceListSchema,
]);

export const candidateAttestationValidationResponseSchema = z
  .object({
    denialReason: z.literal("").optional(),
    result: z.literal("VERIFIED"),
  })
  .strict();

export const candidateAttestationValidationResponsesSchema = z.tuple([
  candidateAttestationValidationResponseSchema,
  candidateAttestationValidationResponseSchema,
]);

export type CandidateAttestationOccurrence = z.infer<typeof candidateAttestationOccurrenceSchema>;
export type CandidateAttestationOccurrenceList = z.infer<
  typeof candidateAttestationOccurrenceListSchema
>;

export interface CandidateAttestationEvidenceItem {
  readonly createTime: string;
  readonly name: string;
  readonly publicKeyId: string;
  readonly resourceUri: string;
  readonly updateTime: string;
  readonly validationResult: "VERIFIED";
}

export interface CandidateAttestationReadbackEvidence {
  readonly attestations: readonly [
    CandidateAttestationEvidenceItem,
    CandidateAttestationEvidenceItem,
  ];
}

export function createCandidateAttestationPayload(image: string): string {
  const parsedImage = digestImageSchema.parse(image);
  const separator = parsedImage.lastIndexOf("@sha256:");
  if (separator < 1) throw new Error("candidate image digest is invalid");
  return `${JSON.stringify(
    {
      critical: {
        identity: { "docker-reference": parsedImage.slice(0, separator) },
        image: { "docker-manifest-digest": parsedImage.slice(separator + 1) },
        type: "Google cloud binauthz container signature",
      },
    },
    undefined,
    2,
  )}\n`;
}

function verifyOccurrence(
  expected: ReleaseSupplyChainDeploymentPlan,
  image: string,
  observed: CandidateAttestationOccurrence,
): CandidateAttestationOccurrence {
  const publicKey = expected.attestor.userOwnedDrydockNote.publicKeys[0];
  const signature = observed.attestation.signatures[0];
  const expectedPayload = Buffer.from(createCandidateAttestationPayload(image), "utf8").toString(
    "base64",
  );
  if (
    new RegExp(`^projects/${expected.projectId}/occurrences/[A-Za-z0-9._~-]{1,128}$`, "u").exec(
      observed.name,
    ) === null ||
    observed.resourceUri !== image ||
    observed.noteName !== expected.artifactAnalysisNote.name ||
    observed.attestation.serializedPayload !== expectedPayload ||
    signature.publicKeyId !== publicKey.id ||
    Buffer.from(signature.signature, "base64").toString("base64") !== signature.signature
  ) {
    throw new Error("release candidate attestation occurrence drifted");
  }
  return observed;
}

export function verifyCandidateAttestationOccurrenceLists(
  expectation: ReleaseSupplyChainDeploymentPlan,
  rawLists: unknown,
): readonly [CandidateAttestationOccurrence, CandidateAttestationOccurrence] {
  const expected = releaseSupplyChainDeploymentPlanSchema.parse(expectation);
  const lists = candidateAttestationOccurrenceListsSchema.parse(rawLists);
  const first = verifyOccurrence(expected, expected.images[0], lists[0].occurrences[0]);
  const second = verifyOccurrence(expected, expected.images[1], lists[1].occurrences[0]);
  if (first.name === second.name) {
    throw new Error("release candidate attestation occurrences must be distinct");
  }
  return [first, second];
}

export function candidateAttestationSnapshotFingerprint(
  expectation: ReleaseSupplyChainDeploymentPlan,
  rawLists: unknown,
): string {
  return JSON.stringify(
    verifyCandidateAttestationOccurrenceLists(expectation, rawLists).map((occurrence) => ({
      attestation: occurrence.attestation,
      createTime: occurrence.createTime,
      name: occurrence.name,
      noteName: occurrence.noteName,
      resourceUri: occurrence.resourceUri,
      updateTime: occurrence.updateTime,
    })),
  );
}

export function verifyCandidateAttestationReadback(
  expectation: ReleaseSupplyChainDeploymentPlan,
  rawLists: unknown,
  rawValidations: unknown,
): CandidateAttestationReadbackEvidence {
  const occurrences = verifyCandidateAttestationOccurrenceLists(expectation, rawLists);
  const validations = candidateAttestationValidationResponsesSchema.parse(rawValidations);
  const evidence = (
    occurrence: CandidateAttestationOccurrence,
    validationResult: "VERIFIED",
  ): CandidateAttestationEvidenceItem => ({
    createTime: occurrence.createTime,
    name: occurrence.name,
    publicKeyId: occurrence.attestation.signatures[0].publicKeyId,
    resourceUri: occurrence.resourceUri,
    updateTime: occurrence.updateTime,
    validationResult,
  });
  return {
    attestations: [
      evidence(occurrences[0], validations[0].result),
      evidence(occurrences[1], validations[1].result),
    ],
  };
}
