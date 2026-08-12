import { z } from "zod";

import { iamBindingReadbackSchema } from "./control-plane-readback.js";
import {
  controllerServiceDeploymentConfigurationSchema,
  type ControllerServiceDeploymentConfiguration,
} from "./service-deployment.js";

const projectNumberSchema = z.string().regex(/^[1-9][0-9]{5,19}$/u);
const resourceNameSchema = z.string().min(1).max(1024);
const serviceAccountSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{4,28}@[a-z][a-z0-9-]{4,28}\.iam\.gserviceaccount\.com$/u);
const digestImageSchema = z
  .string()
  .regex(
    /^asia-southeast1-docker\.pkg\.dev\/[a-z][a-z0-9-]{4,28}\/[a-z0-9._-]+\/[a-z0-9._-]+@sha256:[a-f0-9]{64}$/u,
  );

export const releaseSupplyChainConfigurationSchema = z
  .object({
    deployment: controllerServiceDeploymentConfigurationSchema,
    projectNumber: projectNumberSchema,
  })
  .strict();

export type ReleaseSupplyChainConfiguration = z.infer<typeof releaseSupplyChainConfigurationSchema>;

const artifactAnalysisNotePlanSchema = z
  .object({
    attestation: z
      .object({
        hint: z.object({ humanReadableName: z.literal("ScribeDrop release candidate") }).strict(),
      })
      .strict(),
    longDescription: z.literal(
      "Authorizes controller and worker image digests from one staging-verified release candidate.",
    ),
    name: resourceNameSchema,
    shortDescription: z.literal("ScribeDrop release candidate attestor note."),
  })
  .strict();

const iamResourcePlanSchema = z
  .object({
    bindings: z.array(iamBindingReadbackSchema).min(1).max(3),
    resource: resourceNameSchema,
  })
  .strict();

export const releaseSupplyChainDeploymentPlanSchema = z
  .object({
    apiServices: z.tuple([
      z.literal("artifactregistry.googleapis.com"),
      z.literal("binaryauthorization.googleapis.com"),
      z.literal("cloudkms.googleapis.com"),
      z.literal("cloudresourcemanager.googleapis.com"),
      z.literal("containeranalysis.googleapis.com"),
      z.literal("iamcredentials.googleapis.com"),
      z.literal("sts.googleapis.com"),
    ]),
    artifactAnalysisNote: artifactAnalysisNotePlanSchema,
    attestor: z
      .object({
        description: z.literal("ScribeDrop staging-verified release candidate."),
        name: resourceNameSchema,
        userOwnedGrafeasNote: z
          .object({
            noteReference: resourceNameSchema,
            publicKeys: z.tuple([
              z
                .object({
                  id: z
                    .string()
                    .regex(
                      /^\/\/cloudkms\.googleapis\.com\/v1\/projects\/[a-z][a-z0-9-]{4,28}\/locations\/asia-southeast1\/keyRings\/[a-z][a-z0-9_-]{0,62}\/cryptoKeys\/[a-z][a-z0-9_-]{0,62}\/cryptoKeyVersions\/1$/u,
                    ),
                  pkixPublicKey: z
                    .object({ signatureAlgorithm: z.literal("ECDSA_P256_SHA256") })
                    .strict(),
                })
                .strict(),
            ]),
          })
          .strict(),
      })
      .strict(),
    binaryAuthorizationPolicy: z
      .object({
        admissionWhitelistPatterns: z.array(z.never()).max(0),
        clusterAdmissionRules: z.record(z.string(), z.never()),
        defaultAdmissionRule: z
          .object({
            enforcementMode: z.literal("ENFORCED_BLOCK_AND_AUDIT_LOG"),
            evaluationMode: z.literal("REQUIRE_ATTESTATION"),
            requireAttestationsBy: z.tuple([resourceNameSchema]),
          })
          .strict(),
        globalPolicyEvaluationMode: z.literal("ENABLE"),
        istioServiceIdentityAdmissionRules: z.record(z.string(), z.never()),
        kubernetesNamespaceAdmissionRules: z.record(z.string(), z.never()),
        kubernetesServiceAccountAdmissionRules: z.record(z.string(), z.never()),
        name: resourceNameSchema,
      })
      .strict(),
    identities: z
      .object({
        binaryAuthorizationServiceAgent: serviceAccountSchema,
        publisher: serviceAccountSchema,
        signer: serviceAccountSchema,
      })
      .strict(),
    images: z.tuple([digestImageSchema, digestImageSchema]),
    kms: z
      .object({
        cryptoKey: z
          .object({
            destroyScheduledDuration: z.literal("2592000s"),
            importOnly: z.literal(false),
            labels: z
              .object({ "scribe-drop-component": z.literal("release-supply-chain") })
              .strict(),
            name: resourceNameSchema,
            purpose: z.literal("ASYMMETRIC_SIGN"),
            versionTemplate: z
              .object({
                algorithm: z.literal("EC_SIGN_P256_SHA256"),
                protectionLevel: z.literal("SOFTWARE"),
              })
              .strict(),
          })
          .strict(),
        keyRing: z.object({ name: resourceNameSchema }).strict(),
        signingVersion: z
          .object({
            algorithm: z.literal("EC_SIGN_P256_SHA256"),
            name: resourceNameSchema,
            protectionLevel: z.literal("SOFTWARE"),
            state: z.literal("ENABLED"),
          })
          .strict(),
      })
      .strict(),
    permissions: z
      .object({
        attestor: iamResourcePlanSchema,
        cryptoKey: iamResourcePlanSchema,
        note: iamResourcePlanSchema,
        project: iamResourcePlanSchema,
        repositories: z.tuple([iamResourcePlanSchema, iamResourcePlanSchema]),
      })
      .strict(),
    projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}$/u),
  })
  .strict()
  .superRefine((plan, context) => {
    const project = `projects/${plan.projectId}`;
    const expectedAttestor = `${project}/attestors/scribe-drop-release-candidate`;
    const expectedNote = `${project}/notes/scribe-drop-release-candidate`;
    const expectedKeyRing = `${project}/locations/asia-southeast1/keyRings/scribe-drop-release`;
    const expectedCryptoKey = `${expectedKeyRing}/cryptoKeys/candidate-attestor`;
    const expectedVersion = `${expectedCryptoKey}/cryptoKeyVersions/1`;
    const expectedKeyId = `//cloudkms.googleapis.com/v1/${expectedVersion}`;
    const resourcesMatch =
      plan.artifactAnalysisNote.name === expectedNote &&
      plan.attestor.name === expectedAttestor &&
      plan.attestor.userOwnedGrafeasNote.noteReference === expectedNote &&
      plan.attestor.userOwnedGrafeasNote.publicKeys[0].id === expectedKeyId &&
      plan.binaryAuthorizationPolicy.name === `${project}/policy` &&
      plan.binaryAuthorizationPolicy.defaultAdmissionRule.requireAttestationsBy[0] ===
        expectedAttestor &&
      plan.kms.keyRing.name === expectedKeyRing &&
      plan.kms.cryptoKey.name === expectedCryptoKey &&
      plan.kms.signingVersion.name === expectedVersion;
    if (!resourcesMatch) {
      context.addIssue({ code: "custom", message: "release supply-chain resources drifted" });
    }
    if (plan.identities.publisher === plan.identities.signer) {
      context.addIssue({ code: "custom", message: "publisher and signer must be distinct" });
    }
    if (plan.images[0] === plan.images[1]) {
      context.addIssue({
        code: "custom",
        message: "controller and worker images must be distinct",
      });
    }
  });

export type ReleaseSupplyChainDeploymentPlan = z.infer<
  typeof releaseSupplyChainDeploymentPlanSchema
>;

function imageRepositoryResource(image: string): string {
  const [repository] = image.split("/").slice(2, 3);
  if (repository === undefined) throw new Error("candidate image repository is missing");
  const projectId = image.split("/")[1];
  if (projectId === undefined) throw new Error("candidate image project is missing");
  return `projects/${projectId}/locations/asia-southeast1/repositories/${repository}`;
}

export function createReleaseSupplyChainDeploymentPlan(
  configuration: ReleaseSupplyChainConfiguration,
): ReleaseSupplyChainDeploymentPlan {
  const parsed = releaseSupplyChainConfigurationSchema.parse(configuration);
  const projectId = parsed.deployment.manifest.projectId;
  const project = `projects/${projectId}`;
  const attestor = `${project}/attestors/scribe-drop-release-candidate`;
  const note = `${project}/notes/scribe-drop-release-candidate`;
  const keyRing = `${project}/locations/asia-southeast1/keyRings/scribe-drop-release`;
  const cryptoKey = `${keyRing}/cryptoKeys/candidate-attestor`;
  const keyVersion = `${cryptoKey}/cryptoKeyVersions/1`;
  const signer = `sd-release-signer@${projectId}.iam.gserviceaccount.com`;
  const publisher = `sd-candidate-publisher@${projectId}.iam.gserviceaccount.com`;
  const serviceAgent = `service-${parsed.projectNumber}@gcp-sa-binaryauthorization.iam.gserviceaccount.com`;
  const signerPrincipal = `serviceAccount:${signer}`;
  const publisherPrincipal = `serviceAccount:${publisher}`;
  const serviceAgentPrincipal = `serviceAccount:${serviceAgent}`;
  const images = [
    parsed.deployment.controllerImageDigest,
    parsed.deployment.manifest.imageDigest,
  ] as const;
  const repositories = images.map(imageRepositoryResource);
  if (new Set(repositories).size !== repositories.length) {
    throw new Error("controller and worker repositories must be distinct");
  }

  return releaseSupplyChainDeploymentPlanSchema.parse({
    apiServices: [
      "artifactregistry.googleapis.com",
      "binaryauthorization.googleapis.com",
      "cloudkms.googleapis.com",
      "cloudresourcemanager.googleapis.com",
      "containeranalysis.googleapis.com",
      "iamcredentials.googleapis.com",
      "sts.googleapis.com",
    ],
    artifactAnalysisNote: {
      attestation: { hint: { humanReadableName: "ScribeDrop release candidate" } },
      longDescription:
        "Authorizes controller and worker image digests from one staging-verified release candidate.",
      name: note,
      shortDescription: "ScribeDrop release candidate attestor note.",
    },
    attestor: {
      description: "ScribeDrop staging-verified release candidate.",
      name: attestor,
      userOwnedGrafeasNote: {
        noteReference: note,
        publicKeys: [
          {
            id: `//cloudkms.googleapis.com/v1/${keyVersion}`,
            pkixPublicKey: { signatureAlgorithm: "ECDSA_P256_SHA256" },
          },
        ],
      },
    },
    binaryAuthorizationPolicy: {
      admissionWhitelistPatterns: [],
      clusterAdmissionRules: {},
      defaultAdmissionRule: {
        enforcementMode: "ENFORCED_BLOCK_AND_AUDIT_LOG",
        evaluationMode: "REQUIRE_ATTESTATION",
        requireAttestationsBy: [attestor],
      },
      globalPolicyEvaluationMode: "ENABLE",
      istioServiceIdentityAdmissionRules: {},
      kubernetesNamespaceAdmissionRules: {},
      kubernetesServiceAccountAdmissionRules: {},
      name: `${project}/policy`,
    },
    identities: { binaryAuthorizationServiceAgent: serviceAgent, publisher, signer },
    images,
    kms: {
      cryptoKey: {
        destroyScheduledDuration: "2592000s",
        importOnly: false,
        labels: { "scribe-drop-component": "release-supply-chain" },
        name: cryptoKey,
        purpose: "ASYMMETRIC_SIGN",
        versionTemplate: {
          algorithm: "EC_SIGN_P256_SHA256",
          protectionLevel: "SOFTWARE",
        },
      },
      keyRing: { name: keyRing },
      signingVersion: {
        algorithm: "EC_SIGN_P256_SHA256",
        name: keyVersion,
        protectionLevel: "SOFTWARE",
        state: "ENABLED",
      },
    },
    permissions: {
      attestor: {
        bindings: [
          {
            members: [serviceAgentPrincipal],
            role: "roles/binaryauthorization.attestorsVerifier",
          },
        ],
        resource: attestor,
      },
      cryptoKey: {
        bindings: [{ members: [signerPrincipal], role: "roles/cloudkms.signerVerifier" }],
        resource: cryptoKey,
      },
      note: {
        bindings: [
          {
            members: [serviceAgentPrincipal],
            role: "roles/containeranalysis.notes.occurrences.viewer",
          },
          { members: [signerPrincipal], role: "roles/containeranalysis.notes.attacher" },
        ],
        resource: note,
      },
      project: {
        bindings: [
          {
            members: [signerPrincipal],
            role: "roles/containeranalysis.occurrences.editor",
          },
        ],
        resource: project,
      },
      repositories: [
        {
          bindings: [{ members: [publisherPrincipal], role: "roles/artifactregistry.writer" }],
          resource: repositories[0],
        },
        {
          bindings: [{ members: [publisherPrincipal], role: "roles/artifactregistry.writer" }],
          resource: repositories[1],
        },
      ],
    },
    projectId,
  });
}

export function supplyChainConfigurationFromDeployment(
  deployment: ControllerServiceDeploymentConfiguration,
  projectNumber: string,
): ReleaseSupplyChainConfiguration {
  return releaseSupplyChainConfigurationSchema.parse({ deployment, projectNumber });
}
