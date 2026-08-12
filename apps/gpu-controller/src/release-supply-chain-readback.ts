import { z } from "zod";

import {
  iamPolicyReadbackSchema,
  verifyIamPolicyBindingsReadback,
  verifyIamPrincipalBindingsReadback,
  type IamPolicyReadbackEvidence,
} from "./control-plane-readback.js";
import {
  releaseSupplyChainDeploymentPlanSchema,
  type ReleaseSupplyChainDeploymentPlan,
} from "./release-supply-chain.js";

const timestampSchema = z.iso.datetime({ offset: true });
const resourceNameSchema = z.string().min(1).max(1024);
const pemSchema = z
  .string()
  .min(128)
  .max(4096)
  .refine(
    (value) =>
      value.startsWith("-----BEGIN PUBLIC KEY-----\n") &&
      value.endsWith("-----END PUBLIC KEY-----\n"),
    { message: "KMS public key must be canonical PEM" },
  );

const pkixPublicKeyReadbackSchema = z
  .object({
    publicKeyPem: pemSchema,
    signatureAlgorithm: z.literal("ECDSA_P256_SHA256"),
  })
  .strict();

export const binaryAuthorizationAttestorReadbackSchema = z
  .object({
    description: z.string().max(4096),
    etag: z.string().min(1).max(1024),
    name: resourceNameSchema,
    updateTime: timestampSchema,
    userOwnedDrydockNote: z
      .object({
        delegationServiceAccountEmail: z.email(),
        noteReference: resourceNameSchema,
        publicKeys: z.tuple([
          z
            .object({
              comment: z.literal("").optional(),
              id: z.string().min(1).max(1024),
              pkixPublicKey: pkixPublicKeyReadbackSchema,
            })
            .strict(),
        ]),
      })
      .strict(),
  })
  .strict();

export const artifactAnalysisAttestorNoteReadbackSchema = z
  .object({
    attestation: z
      .object({
        hint: z.object({ humanReadableName: z.string().min(1).max(256) }).strict(),
      })
      .strict(),
    createTime: timestampSchema,
    expirationTime: z.never().optional(),
    kind: z.literal("ATTESTATION_AUTHORITY"),
    longDescription: z.string().max(4096),
    name: resourceNameSchema,
    relatedNoteNames: z.array(resourceNameSchema).max(1).optional(),
    relatedUrl: z
      .array(z.object({ label: z.string().max(1024), url: z.url() }).strict())
      .max(1)
      .optional(),
    shortDescription: z.string().max(256),
    updateTime: timestampSchema,
  })
  .strict();

const cryptoKeyVersionReadbackSchema = z
  .object({
    algorithm: z.literal("EC_SIGN_P256_SHA256"),
    attestation: z.never().optional(),
    createTime: timestampSchema,
    destroyEventTime: z.never().optional(),
    destroyTime: z.never().optional(),
    externalDestructionFailureReason: z.never().optional(),
    externalProtectionLevelOptions: z.never().optional(),
    generateTime: timestampSchema,
    generationFailureReason: z.never().optional(),
    importFailureReason: z.never().optional(),
    importJob: z.never().optional(),
    importTime: z.never().optional(),
    name: resourceNameSchema,
    protectionLevel: z.literal("SOFTWARE"),
    reimportEligible: z.literal(false).optional(),
    state: z.literal("ENABLED"),
  })
  .strict();

export const kmsCryptoKeyReadbackSchema = z
  .object({
    createTime: timestampSchema,
    cryptoKeyBackend: z.never().optional(),
    destroyScheduledDuration: z.literal("2592000s"),
    importOnly: z.literal(false),
    labels: z.object({ "scribe-drop-component": z.literal("release-supply-chain") }).strict(),
    name: resourceNameSchema,
    nextRotationTime: z.never().optional(),
    primary: z.never().optional(),
    purpose: z.literal("ASYMMETRIC_SIGN"),
    rotationPeriod: z.never().optional(),
    versionTemplate: z
      .object({
        algorithm: z.literal("EC_SIGN_P256_SHA256"),
        protectionLevel: z.literal("SOFTWARE"),
      })
      .strict(),
  })
  .strict();

export const kmsCryptoKeyVersionListReadbackSchema = z
  .object({
    cryptoKeyVersions: z.tuple([cryptoKeyVersionReadbackSchema]),
    nextPageToken: z.never().optional(),
    totalSize: z.literal(1).optional(),
  })
  .strict();

export const kmsPublicKeyReadbackSchema = z
  .object({
    algorithm: z.literal("EC_SIGN_P256_SHA256"),
    name: resourceNameSchema,
    pem: pemSchema,
    pemCrc32c: z.string().regex(/^(?:0|[1-9][0-9]{0,9})$/u),
    protectionLevel: z.literal("SOFTWARE"),
    publicKey: z.never().optional(),
    publicKeyFormat: z.literal("PEM").optional(),
  })
  .strict();

const repositoryIamReadbackSchema = z
  .object({ iamPolicy: iamPolicyReadbackSchema, resource: resourceNameSchema })
  .strict();

export const releaseSupplyChainRawReadbackSchema = z
  .object({
    attestor: binaryAuthorizationAttestorReadbackSchema,
    attestorIamPolicy: iamPolicyReadbackSchema,
    cryptoKey: kmsCryptoKeyReadbackSchema,
    cryptoKeyIamPolicy: iamPolicyReadbackSchema,
    cryptoKeyVersions: kmsCryptoKeyVersionListReadbackSchema,
    kmsPublicKey: kmsPublicKeyReadbackSchema,
    note: artifactAnalysisAttestorNoteReadbackSchema,
    noteIamPolicy: iamPolicyReadbackSchema,
    projectIamPolicy: iamPolicyReadbackSchema,
    repositories: z.tuple([repositoryIamReadbackSchema, repositoryIamReadbackSchema]),
  })
  .strict();

export type ReleaseSupplyChainRawReadback = z.input<typeof releaseSupplyChainRawReadbackSchema>;

export interface ReleaseSupplyChainReadbackEvidence {
  readonly attestorEtag: string;
  readonly attestorUpdateTime: string;
  readonly cryptoKeyCreateTime: string;
  readonly cryptoKeyIam: IamPolicyReadbackEvidence;
  readonly keyVersionCreateTime: string;
  readonly keyVersionGenerateTime: string;
  readonly noteCreateTime: string;
  readonly noteIam: IamPolicyReadbackEvidence;
  readonly noteUpdateTime: string;
  readonly projectIam: IamPolicyReadbackEvidence;
  readonly repositoryIam: readonly [IamPolicyReadbackEvidence, IamPolicyReadbackEvidence];
}

function crc32c(value: string): string {
  let checksum = 0xffffffff;
  for (const byte of new TextEncoder().encode(value)) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0x82f63b78 : 0);
    }
  }
  return String((checksum ^ 0xffffffff) >>> 0);
}

function verifyRepositoryIam(
  plan: ReleaseSupplyChainDeploymentPlan,
  observed: z.infer<typeof repositoryIamReadbackSchema>,
): IamPolicyReadbackEvidence {
  const expected = plan.permissions.repositories.find(
    ({ resource }) => resource === observed.resource,
  );
  if (expected === undefined) throw new Error("candidate repository read-back escaped the plan");
  return verifyIamPrincipalBindingsReadback(
    `serviceAccount:${plan.identities.publisher}`,
    expected.bindings,
    observed.iamPolicy,
  );
}

export function verifyReleaseSupplyChainReadback(
  expectation: ReleaseSupplyChainDeploymentPlan,
  rawReadback: unknown,
): ReleaseSupplyChainReadbackEvidence {
  const expected = releaseSupplyChainDeploymentPlanSchema.parse(expectation);
  const observed = releaseSupplyChainRawReadbackSchema.parse(rawReadback);
  const publicKey = observed.attestor.userOwnedDrydockNote.publicKeys[0];
  const expectedPublicKey = expected.attestor.userOwnedDrydockNote.publicKeys[0];
  if (
    observed.attestor.name !== expected.attestor.name ||
    observed.attestor.description !== expected.attestor.description ||
    observed.attestor.userOwnedDrydockNote.noteReference !==
      expected.attestor.userOwnedDrydockNote.noteReference ||
    observed.attestor.userOwnedDrydockNote.delegationServiceAccountEmail !==
      expected.identities.binaryAuthorizationServiceAgent ||
    publicKey.id !== expectedPublicKey.id
  ) {
    throw new Error("Binary Authorization attestor read-back drifted");
  }
  if (
    observed.kmsPublicKey.name !== expected.kms.signingVersion.name ||
    observed.kmsPublicKey.pem !== publicKey.pkixPublicKey.publicKeyPem ||
    observed.kmsPublicKey.pemCrc32c !== crc32c(observed.kmsPublicKey.pem)
  ) {
    throw new Error("attestor public key does not match the KMS signing version");
  }
  if (
    observed.note.name !== expected.artifactAnalysisNote.name ||
    observed.note.shortDescription !== expected.artifactAnalysisNote.shortDescription ||
    observed.note.longDescription !== expected.artifactAnalysisNote.longDescription ||
    observed.note.attestation.hint.humanReadableName !==
      expected.artifactAnalysisNote.attestation.hint.humanReadableName ||
    (observed.note.relatedNoteNames ?? []).length !== 0 ||
    (observed.note.relatedUrl ?? []).length !== 0
  ) {
    throw new Error("Artifact Analysis attestor Note read-back drifted");
  }
  if (observed.cryptoKey.name !== expected.kms.cryptoKey.name) {
    throw new Error("KMS CryptoKey read-back drifted");
  }
  const version = observed.cryptoKeyVersions.cryptoKeyVersions[0];
  if (version.name !== expected.kms.signingVersion.name) {
    throw new Error("KMS signing version read-back drifted");
  }

  verifyIamPolicyBindingsReadback(
    expected.permissions.attestor.bindings,
    observed.attestorIamPolicy,
  );
  const noteIam = verifyIamPolicyBindingsReadback(
    expected.permissions.note.bindings,
    observed.noteIamPolicy,
  );
  const cryptoKeyIam = verifyIamPolicyBindingsReadback(
    expected.permissions.cryptoKey.bindings,
    observed.cryptoKeyIamPolicy,
  );
  const projectIam = verifyIamPrincipalBindingsReadback(
    `serviceAccount:${expected.identities.signer}`,
    expected.permissions.project.bindings,
    observed.projectIamPolicy,
  );
  if (new Set(observed.repositories.map(({ resource }) => resource)).size !== 2) {
    throw new Error("candidate repository read-back contains duplicates");
  }
  const repositoryIam = observed.repositories.map((repository) =>
    verifyRepositoryIam(expected, repository),
  );
  const firstRepositoryIam = repositoryIam[0];
  const secondRepositoryIam = repositoryIam[1];
  if (firstRepositoryIam === undefined || secondRepositoryIam === undefined) {
    throw new Error("candidate repository read-back is incomplete");
  }
  return {
    attestorEtag: observed.attestor.etag,
    attestorUpdateTime: observed.attestor.updateTime,
    cryptoKeyCreateTime: observed.cryptoKey.createTime,
    cryptoKeyIam,
    keyVersionCreateTime: version.createTime,
    keyVersionGenerateTime: version.generateTime,
    noteCreateTime: observed.note.createTime,
    noteIam,
    noteUpdateTime: observed.note.updateTime,
    projectIam,
    repositoryIam: [firstRepositoryIam, secondRepositoryIam],
  };
}
