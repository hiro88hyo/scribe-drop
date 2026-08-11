import { z } from "zod";

import {
  iamBindingReadbackSchema,
  iamCustomRoleExpectationSchema,
  iamCustomRoleReadbackSchema,
  iamPolicyReadbackSchema,
  verifyIamCustomRoleReadback,
  verifyIamPrincipalBindingsReadback,
  type IamCustomRoleReadbackEvidence,
  type IamPolicyReadbackEvidence,
} from "./control-plane-readback.js";
import {
  controllerServiceDeploymentConfigurationSchema,
  type ControllerServiceDeploymentConfiguration,
} from "./service-deployment.js";

export const cloudRunControllerPermissions = [
  "run.executions.cancel",
  "run.executions.delete",
  "run.executions.list",
  "run.jobs.create",
  "run.jobs.delete",
  "run.jobs.get",
  "run.jobs.run",
  "run.operations.get",
] as const;

export const firestoreControllerPermissions = [
  "datastore.databases.get",
  "datastore.entities.create",
  "datastore.entities.delete",
  "datastore.entities.get",
  "datastore.entities.update",
] as const;

const resourceNameSchema = z.string().min(1).max(1024);
const projectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}$/u);

function hasExactPermissions(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((permission, index) => permission === expected[index])
  );
}

export const controllerIamDeploymentPlanSchema = z
  .object({
    artifactRepository: z
      .object({
        bindings: z.tuple([iamBindingReadbackSchema]),
        resource: resourceNameSchema,
      })
      .strict(),
    cloudRunRole: iamCustomRoleExpectationSchema,
    controllerPrincipal: z
      .string()
      .regex(
        /^serviceAccount:[a-z][a-z0-9-]{4,28}@[a-z][a-z0-9-]{4,28}\.iam\.gserviceaccount\.com$/u,
      ),
    firestoreRole: iamCustomRoleExpectationSchema,
    projectBindings: z.tuple([iamBindingReadbackSchema, iamBindingReadbackSchema]),
    projectResource: z.string().regex(/^projects\/[a-z][a-z0-9-]{4,28}$/u),
    runtimeServiceAccount: z
      .object({
        bindings: z.tuple([iamBindingReadbackSchema]),
        resource: resourceNameSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, context) => {
    const projectId = plan.projectResource.slice("projects/".length);
    if (!projectIdSchema.safeParse(projectId).success) {
      context.addIssue({ code: "custom", message: "IAM project resource is invalid" });
      return;
    }
    const expectedCloudRunRoleName = `${plan.projectResource}/roles/scribeDropCloudRunController`;
    const expectedFirestoreRoleName = `${plan.projectResource}/roles/scribeDropFirestoreController`;
    const roleMetadataMatches =
      plan.cloudRunRole.name === expectedCloudRunRoleName &&
      plan.cloudRunRole.title === "ScribeDrop Cloud Run controller" &&
      plan.cloudRunRole.description ===
        "Minimum Cloud Run Jobs permissions for the ScribeDrop GPU controller." &&
      plan.cloudRunRole.stage === "GA" &&
      hasExactPermissions(plan.cloudRunRole.includedPermissions, cloudRunControllerPermissions) &&
      plan.firestoreRole.name === expectedFirestoreRoleName &&
      plan.firestoreRole.title === "ScribeDrop Firestore controller" &&
      plan.firestoreRole.description ===
        "Minimum Firestore transaction permissions for the ScribeDrop GPU controller." &&
      plan.firestoreRole.stage === "GA" &&
      hasExactPermissions(plan.firestoreRole.includedPermissions, firestoreControllerPermissions);
    if (!roleMetadataMatches) {
      context.addIssue({ code: "custom", message: "controller custom IAM roles drifted" });
    }
    const controllerProject =
      /^serviceAccount:[^@]+@([a-z][a-z0-9-]{4,28})\.iam\.gserviceaccount\.com$/u.exec(
        plan.controllerPrincipal,
      )?.[1];
    if (controllerProject !== projectId) {
      context.addIssue({
        code: "custom",
        message: "controller identity belongs to another project",
      });
    }
    const artifactPrefix = `${plan.projectResource}/locations/asia-southeast1/repositories/`;
    if (
      !plan.artifactRepository.resource.startsWith(artifactPrefix) ||
      !/^[a-z][a-z0-9-]{0,62}$/u.test(plan.artifactRepository.resource.slice(artifactPrefix.length))
    ) {
      context.addIssue({ code: "custom", message: "Artifact Registry resource drifted" });
    }
    const runtimePrefix = `${plan.projectResource}/serviceAccounts/`;
    const runtimeEmail = plan.runtimeServiceAccount.resource.slice(runtimePrefix.length);
    if (
      !plan.runtimeServiceAccount.resource.startsWith(runtimePrefix) ||
      !new RegExp(`^[a-z][a-z0-9-]{4,28}@${projectId}\\.iam\\.gserviceaccount\\.com$`, "u").test(
        runtimeEmail,
      )
    ) {
      context.addIssue({ code: "custom", message: "runtime identity resource drifted" });
    }
    const expectedMember = plan.controllerPrincipal;
    const allBindings = [
      ...plan.projectBindings,
      ...plan.artifactRepository.bindings,
      ...plan.runtimeServiceAccount.bindings,
    ];
    if (
      allBindings.some(
        (binding) => binding.members.length !== 1 || binding.members[0] !== expectedMember,
      )
    ) {
      context.addIssue({ code: "custom", message: "IAM bindings must isolate the controller" });
    }
    const firestoreCondition = plan.projectBindings[1].condition;
    if (
      plan.projectBindings[0].role !== plan.cloudRunRole.name ||
      plan.projectBindings[0].condition !== undefined ||
      plan.projectBindings[1].role !== plan.firestoreRole.name ||
      firestoreCondition?.description !==
        "Restricts controller transactions to its environment database." ||
      !new RegExp(
        `^resource\\.name == "projects/${projectId}/databases/[a-z][a-z0-9-]{0,62}"$`,
        "u",
      ).test(firestoreCondition.expression) ||
      !/^ScribeDrop (?:staging|production) Firestore database$/u.test(firestoreCondition.title)
    ) {
      context.addIssue({ code: "custom", message: "project IAM role bindings drifted" });
    }
    if (plan.artifactRepository.bindings[0].role !== "roles/artifactregistry.reader") {
      context.addIssue({ code: "custom", message: "Artifact Registry role must be reader" });
    }
    if (plan.runtimeServiceAccount.bindings[0].role !== "roles/iam.serviceAccountUser") {
      context.addIssue({ code: "custom", message: "runtime identity role must only grant actAs" });
    }
  });

export type ControllerIamDeploymentPlan = z.infer<typeof controllerIamDeploymentPlanSchema>;

export function createControllerIamDeploymentPlan(
  configuration: ControllerServiceDeploymentConfiguration,
): ControllerIamDeploymentPlan {
  const parsed = controllerServiceDeploymentConfigurationSchema.parse(configuration);
  const projectId = parsed.manifest.projectId;
  const controllerPrincipal = `serviceAccount:${parsed.controllerServiceAccount}`;
  const imageParts = parsed.manifest.imageDigest.split("/");
  const repository = imageParts[2];
  if (repository === undefined) throw new Error("worker image repository is missing");
  const cloudRunRole = {
    deleted: false as const,
    description: "Minimum Cloud Run Jobs permissions for the ScribeDrop GPU controller.",
    includedPermissions: [...cloudRunControllerPermissions],
    name: `projects/${projectId}/roles/scribeDropCloudRunController`,
    stage: "GA" as const,
    title: "ScribeDrop Cloud Run controller",
  };
  const firestoreRole = {
    deleted: false as const,
    description: "Minimum Firestore transaction permissions for the ScribeDrop GPU controller.",
    includedPermissions: [...firestoreControllerPermissions],
    name: `projects/${projectId}/roles/scribeDropFirestoreController`,
    stage: "GA" as const,
    title: "ScribeDrop Firestore controller",
  };
  return controllerIamDeploymentPlanSchema.parse({
    artifactRepository: {
      bindings: [
        {
          members: [controllerPrincipal],
          role: "roles/artifactregistry.reader",
        },
      ],
      resource: `projects/${projectId}/locations/asia-southeast1/repositories/${repository}`,
    },
    cloudRunRole,
    controllerPrincipal,
    firestoreRole,
    projectBindings: [
      { members: [controllerPrincipal], role: cloudRunRole.name },
      {
        condition: {
          description: "Restricts controller transactions to its environment database.",
          expression: `resource.name == "projects/${projectId}/databases/${parsed.firestore.databaseId}"`,
          title: `ScribeDrop ${parsed.manifest.environment} Firestore database`,
        },
        members: [controllerPrincipal],
        role: firestoreRole.name,
      },
    ],
    projectResource: `projects/${projectId}`,
    runtimeServiceAccount: {
      bindings: [
        {
          members: [controllerPrincipal],
          role: "roles/iam.serviceAccountUser",
        },
      ],
      resource: `projects/${projectId}/serviceAccounts/${parsed.manifest.runtimeServiceAccount}`,
    },
  });
}

export const controllerIamRawReadbackSchema = z
  .object({
    artifactRepository: z
      .object({ iamPolicy: iamPolicyReadbackSchema, resource: resourceNameSchema })
      .strict(),
    cloudRunRole: iamCustomRoleReadbackSchema,
    firestoreRole: iamCustomRoleReadbackSchema,
    project: z
      .object({ iamPolicy: iamPolicyReadbackSchema, resource: resourceNameSchema })
      .strict(),
    runtimeServiceAccount: z
      .object({ iamPolicy: iamPolicyReadbackSchema, resource: resourceNameSchema })
      .strict(),
  })
  .strict();

export type ControllerIamRawReadback = z.input<typeof controllerIamRawReadbackSchema>;

export interface ControllerIamReadbackEvidence {
  readonly artifactRepository: IamPolicyReadbackEvidence;
  readonly cloudRunRole: IamCustomRoleReadbackEvidence;
  readonly firestoreRole: IamCustomRoleReadbackEvidence;
  readonly project: IamPolicyReadbackEvidence;
  readonly runtimeServiceAccount: IamPolicyReadbackEvidence;
}

export function verifyControllerIamReadback(
  expectation: ControllerIamDeploymentPlan,
  rawReadback: unknown,
): ControllerIamReadbackEvidence {
  const expected = controllerIamDeploymentPlanSchema.parse(expectation);
  const observed = controllerIamRawReadbackSchema.parse(rawReadback);
  if (
    observed.artifactRepository.resource !== expected.artifactRepository.resource ||
    observed.project.resource !== expected.projectResource ||
    observed.runtimeServiceAccount.resource !== expected.runtimeServiceAccount.resource
  ) {
    throw new Error("controller IAM policy read-back belongs to an unexpected resource");
  }
  return {
    artifactRepository: verifyIamPrincipalBindingsReadback(
      expected.controllerPrincipal,
      expected.artifactRepository.bindings,
      observed.artifactRepository.iamPolicy,
    ),
    cloudRunRole: verifyIamCustomRoleReadback(expected.cloudRunRole, observed.cloudRunRole),
    firestoreRole: verifyIamCustomRoleReadback(expected.firestoreRole, observed.firestoreRole),
    project: verifyIamPrincipalBindingsReadback(
      expected.controllerPrincipal,
      expected.projectBindings,
      observed.project.iamPolicy,
    ),
    runtimeServiceAccount: verifyIamPrincipalBindingsReadback(
      expected.controllerPrincipal,
      expected.runtimeServiceAccount.bindings,
      observed.runtimeServiceAccount.iamPolicy,
    ),
  };
}
