import { z } from "zod";

import {
  releaseSupplyChainDeploymentPlanSchema,
  type ReleaseSupplyChainDeploymentPlan,
} from "./release-supply-chain.js";

const githubRepository = "hiro88hyo/scribe-drop";
const githubRepositoryOwnerId = "1670222";
const githubRepositoryId = "1312444559";
const githubWorkflowPath = ".github/workflows/publish-cloud-run-candidate.yml";
const resourceNameSchema = z.string().min(1).max(1024);

const serviceAccountWorkloadBindingSchema = z
  .object({
    bindings: z.tuple([
      z
        .object({
          condition: z.never().optional(),
          members: z.tuple([resourceNameSchema]),
          role: z.literal("roles/iam.workloadIdentityUser"),
        })
        .strict(),
    ]),
    resource: resourceNameSchema,
  })
  .strict();

export const releaseWorkloadIdentityPlanSchema = z
  .object({
    github: z
      .object({
        repository: z.literal(githubRepository),
        repositoryId: z.literal(githubRepositoryId),
        repositoryOwnerId: z.literal(githubRepositoryOwnerId),
        workflowPath: z.literal(githubWorkflowPath),
      })
      .strict(),
    permissions: z
      .object({
        publisher: serviceAccountWorkloadBindingSchema,
        signer: serviceAccountWorkloadBindingSchema,
      })
      .strict(),
    pool: z
      .object({
        description: z.literal("Federates the ScribeDrop release candidate workflow."),
        disabled: z.literal(false),
        displayName: z.literal("ScribeDrop release"),
        mode: z.literal("FEDERATION_ONLY"),
        name: resourceNameSchema,
      })
      .strict(),
    principalSet: z.string().min(1).max(1024),
    projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}$/u),
    projectNumber: z.string().regex(/^[1-9][0-9]{5,19}$/u),
    provider: z
      .object({
        attributeCondition: z.literal(githubAttributeCondition()),
        attributeMapping: z
          .object({
            "attribute.repository_id": z.literal("assertion.repository_id"),
            "attribute.repository_owner_id": z.literal("assertion.repository_owner_id"),
            "google.subject": z.literal("assertion.sub"),
          })
          .strict(),
        description: z.literal("Trusts only the immutable ScribeDrop release workflow identity."),
        disabled: z.literal(false),
        displayName: z.literal("ScribeDrop GitHub"),
        name: resourceNameSchema,
        oidc: z
          .object({
            allowedAudiences: z.array(z.never()).max(0),
            issuerUri: z.literal("https://token.actions.githubusercontent.com"),
          })
          .strict(),
      })
      .strict(),
    serviceAccounts: z.tuple([
      z
        .object({
          description: z.literal("Publishes immutable ScribeDrop Cloud Run candidate images."),
          displayName: z.literal("ScribeDrop candidate publisher"),
          email: z.email(),
          name: resourceNameSchema,
        })
        .strict(),
      z
        .object({
          description: z.literal("Signs verified ScribeDrop release candidate image digests."),
          displayName: z.literal("ScribeDrop release signer"),
          email: z.email(),
          name: resourceNameSchema,
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((plan, context) => {
    const pool = `projects/${plan.projectNumber}/locations/global/workloadIdentityPools/scribe-drop-release`;
    const provider = `${pool}/providers/github-actions`;
    const expectedPrincipal = `principalSet://iam.googleapis.com/${pool}/attribute.repository_id/${githubRepositoryId}`;
    const publisher = `sd-candidate-publisher@${plan.projectId}.iam.gserviceaccount.com`;
    const signer = `sd-release-signer@${plan.projectId}.iam.gserviceaccount.com`;
    const resourcesMatch =
      plan.pool.name === pool &&
      plan.provider.name === provider &&
      plan.principalSet === expectedPrincipal &&
      plan.serviceAccounts[0].email === publisher &&
      plan.serviceAccounts[0].name === `projects/${plan.projectId}/serviceAccounts/${publisher}` &&
      plan.serviceAccounts[1].email === signer &&
      plan.serviceAccounts[1].name === `projects/${plan.projectId}/serviceAccounts/${signer}` &&
      plan.permissions.publisher.resource === plan.serviceAccounts[0].name &&
      plan.permissions.signer.resource === plan.serviceAccounts[1].name &&
      plan.permissions.publisher.bindings[0].members[0] === expectedPrincipal &&
      plan.permissions.signer.bindings[0].members[0] === expectedPrincipal;
    if (!resourcesMatch) {
      context.addIssue({ code: "custom", message: "release workload identity resources drifted" });
    }
  });

export type ReleaseWorkloadIdentityPlan = z.infer<typeof releaseWorkloadIdentityPlanSchema>;

function githubAttributeCondition(): string {
  const immutableSubject = `repo:hiro88hyo@${githubRepositoryOwnerId}/scribe-drop@${githubRepositoryId}:ref:refs/heads/release/`;
  const workflowRef = `${githubRepository}/${githubWorkflowPath}@refs/heads/release/`;
  return [
    `assertion.repository_id == '${githubRepositoryId}'`,
    `assertion.repository_owner_id == '${githubRepositoryOwnerId}'`,
    `assertion.sub.startsWith('${immutableSubject}')`,
    "assertion.ref.startsWith('refs/heads/release/')",
    "assertion.ref_type == 'branch'",
    "assertion.event_name == 'workflow_dispatch'",
    `assertion.workflow_ref.startsWith('${workflowRef}')`,
  ].join(" && ");
}

function projectNumberFromBinaryAuthorizationServiceAgent(serviceAccount: string): string {
  const match =
    /^service-([1-9][0-9]{5,19})@gcp-sa-binaryauthorization\.iam\.gserviceaccount\.com$/u.exec(
      serviceAccount,
    );
  const projectNumber = match?.[1];
  if (projectNumber === undefined) {
    throw new Error("release workload identity project number is unavailable");
  }
  return projectNumber;
}

export function createReleaseWorkloadIdentityPlan(
  supplyChain: ReleaseSupplyChainDeploymentPlan,
): ReleaseWorkloadIdentityPlan {
  const parsed = releaseSupplyChainDeploymentPlanSchema.parse(supplyChain);
  const projectNumber = projectNumberFromBinaryAuthorizationServiceAgent(
    parsed.identities.binaryAuthorizationServiceAgent,
  );
  const pool = `projects/${projectNumber}/locations/global/workloadIdentityPools/scribe-drop-release`;
  const principalSet = `principalSet://iam.googleapis.com/${pool}/attribute.repository_id/${githubRepositoryId}`;
  const publisherName = `projects/${parsed.projectId}/serviceAccounts/${parsed.identities.publisher}`;
  const signerName = `projects/${parsed.projectId}/serviceAccounts/${parsed.identities.signer}`;
  return releaseWorkloadIdentityPlanSchema.parse({
    github: {
      repository: githubRepository,
      repositoryId: githubRepositoryId,
      repositoryOwnerId: githubRepositoryOwnerId,
      workflowPath: githubWorkflowPath,
    },
    permissions: {
      publisher: {
        bindings: [{ members: [principalSet], role: "roles/iam.workloadIdentityUser" }],
        resource: publisherName,
      },
      signer: {
        bindings: [{ members: [principalSet], role: "roles/iam.workloadIdentityUser" }],
        resource: signerName,
      },
    },
    pool: {
      description: "Federates the ScribeDrop release candidate workflow.",
      disabled: false,
      displayName: "ScribeDrop release",
      mode: "FEDERATION_ONLY",
      name: pool,
    },
    principalSet,
    projectId: parsed.projectId,
    projectNumber,
    provider: {
      attributeCondition: githubAttributeCondition(),
      attributeMapping: {
        "attribute.repository_id": "assertion.repository_id",
        "attribute.repository_owner_id": "assertion.repository_owner_id",
        "google.subject": "assertion.sub",
      },
      description: "Trusts only the immutable ScribeDrop release workflow identity.",
      disabled: false,
      displayName: "ScribeDrop GitHub",
      name: `${pool}/providers/github-actions`,
      oidc: {
        allowedAudiences: [],
        issuerUri: "https://token.actions.githubusercontent.com",
      },
    },
    serviceAccounts: [
      {
        description: "Publishes immutable ScribeDrop Cloud Run candidate images.",
        displayName: "ScribeDrop candidate publisher",
        email: parsed.identities.publisher,
        name: publisherName,
      },
      {
        description: "Signs verified ScribeDrop release candidate image digests.",
        displayName: "ScribeDrop release signer",
        email: parsed.identities.signer,
        name: signerName,
      },
    ],
  });
}
