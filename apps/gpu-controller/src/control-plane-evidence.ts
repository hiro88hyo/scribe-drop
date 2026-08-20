import { z } from "zod";

import {
  binaryAuthorizationPolicyReadbackSchema,
  binaryAuthorizationReadbackExpectationSchema,
  iamPolicyReadbackSchema,
  secretManagerSecretReadbackSchema,
  secretManagerVersionReadbackSchema,
  verifyBinaryAuthorizationPolicyReadback,
  verifyControllerSecretReadback,
  verifyControllerServiceIamReadback,
  type BinaryAuthorizationReadbackEvidence,
  type ControllerSecretReadbackEvidence,
  type IamPolicyReadbackEvidence,
} from "./control-plane-readback.js";
import {
  controllerServiceDeploymentConfigurationSchema,
  createControllerServiceDeploymentPlan,
} from "./service-deployment.js";
import {
  cloudRunV2ControllerServiceReadbackSchema,
  verifyCloudRunV2ControllerServiceReadback,
  type ControllerServiceReadbackEvidence,
} from "./service-readback.js";

const secretObservationSchema = z
  .object({
    iamPolicy: iamPolicyReadbackSchema,
    secret: secretManagerSecretReadbackSchema,
    version: secretManagerVersionReadbackSchema,
  })
  .strict();

export const controllerControlPlaneReadbackExpectationSchema = z
  .object({
    binaryAuthorization: binaryAuthorizationReadbackExpectationSchema,
    deployment: controllerServiceDeploymentConfigurationSchema,
    projectNumber: z.string().regex(/^[1-9][0-9]{5,19}$/u),
  })
  .strict()
  .superRefine((expectation, context) => {
    if (expectation.binaryAuthorization.projectId !== expectation.deployment.manifest.projectId) {
      context.addIssue({
        code: "custom",
        message: "control-plane observations must belong to the deployment project",
      });
    }
  });

export const controllerControlPlaneRawReadbackSchema = z
  .object({
    binaryAuthorizationPolicy: binaryAuthorizationPolicyReadbackSchema,
    primarySecret: secretObservationSchema,
    secondarySecret: secretObservationSchema.optional(),
    service: cloudRunV2ControllerServiceReadbackSchema,
    serviceIamPolicy: iamPolicyReadbackSchema,
  })
  .strict();

export type ControllerControlPlaneReadbackExpectation = z.infer<
  typeof controllerControlPlaneReadbackExpectationSchema
>;

export interface ControllerControlPlaneReadbackEvidence {
  readonly binaryAuthorization: BinaryAuthorizationReadbackEvidence;
  readonly environment: "production" | "staging";
  readonly primarySecret: ControllerSecretReadbackEvidence;
  readonly projectId: string;
  readonly secondarySecret?: ControllerSecretReadbackEvidence;
  readonly service: ControllerServiceReadbackEvidence;
  readonly serviceIam: IamPolicyReadbackEvidence;
}

export function verifyControllerControlPlaneReadback(
  expectation: ControllerControlPlaneReadbackExpectation,
  rawReadback: unknown,
): ControllerControlPlaneReadbackEvidence {
  const expected = controllerControlPlaneReadbackExpectationSchema.parse(expectation);
  const observed = controllerControlPlaneRawReadbackSchema.parse(rawReadback);
  const plan = createControllerServiceDeploymentPlan(expected.deployment);
  const service = verifyCloudRunV2ControllerServiceReadback(plan, observed.service);
  const serviceIam = verifyControllerServiceIamReadback(observed.serviceIamPolicy);
  const primarySecret = verifyControllerSecretReadback(
    {
      controllerServiceAccount: expected.deployment.controllerServiceAccount,
      environment: expected.deployment.manifest.environment,
      name: expected.deployment.primaryHmacSecret.name,
      projectId: expected.deployment.manifest.projectId,
      projectNumber: expected.projectNumber,
      version: expected.deployment.primaryHmacSecret.version,
    },
    observed.primarySecret.secret,
    observed.primarySecret.version,
    observed.primarySecret.iamPolicy,
  );
  const expectedSecondary = expected.deployment.secondaryHmacSecret;
  if ((expectedSecondary === undefined) !== (observed.secondarySecret === undefined)) {
    throw new Error("secondary controller secret observation does not match the deployment plan");
  }
  const secondarySecret =
    expectedSecondary === undefined || observed.secondarySecret === undefined
      ? undefined
      : verifyControllerSecretReadback(
          {
            controllerServiceAccount: expected.deployment.controllerServiceAccount,
            environment: expected.deployment.manifest.environment,
            name: expectedSecondary.name,
            projectId: expected.deployment.manifest.projectId,
            projectNumber: expected.projectNumber,
            version: expectedSecondary.version,
          },
          observed.secondarySecret.secret,
          observed.secondarySecret.version,
          observed.secondarySecret.iamPolicy,
        );
  const binaryAuthorization = verifyBinaryAuthorizationPolicyReadback(
    expected.binaryAuthorization,
    observed.binaryAuthorizationPolicy,
  );
  return {
    binaryAuthorization,
    environment: expected.deployment.manifest.environment,
    primarySecret,
    projectId: expected.deployment.manifest.projectId,
    ...(secondarySecret === undefined ? {} : { secondarySecret }),
    service,
    serviceIam,
  };
}
