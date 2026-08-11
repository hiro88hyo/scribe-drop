import {
  controllerControlPlaneRawReadbackSchema,
  controllerControlPlaneReadbackExpectationSchema,
  verifyControllerControlPlaneReadback,
  type ControllerControlPlaneReadbackEvidence,
  type ControllerControlPlaneReadbackExpectation,
} from "./control-plane-evidence.js";
import {
  controllerFirestoreRawReadbackSchema,
  createControllerFirestoreDeploymentPlan,
  verifyControllerFirestoreReadback,
  type ControllerFirestoreReadbackEvidence,
} from "./firestore-deployment.js";
import {
  controllerIamRawReadbackSchema,
  createControllerIamDeploymentPlan,
  verifyControllerIamReadback,
  type ControllerIamReadbackEvidence,
} from "./iam-deployment.js";
import { z } from "zod";

export const controllerDeploymentRawReadbackSchema = z
  .object({
    controlPlane: controllerControlPlaneRawReadbackSchema,
    firestore: controllerFirestoreRawReadbackSchema,
    iam: controllerIamRawReadbackSchema,
  })
  .strict();

export interface ControllerDeploymentReadbackEvidence {
  readonly controlPlane: ControllerControlPlaneReadbackEvidence;
  readonly environment: "production" | "staging";
  readonly firestore: ControllerFirestoreReadbackEvidence;
  readonly iam: ControllerIamReadbackEvidence;
  readonly projectId: string;
}

export function verifyControllerDeploymentReadback(
  expectation: ControllerControlPlaneReadbackExpectation,
  rawReadback: unknown,
): ControllerDeploymentReadbackEvidence {
  const expected = controllerControlPlaneReadbackExpectationSchema.parse(expectation);
  const observed = controllerDeploymentRawReadbackSchema.parse(rawReadback);
  const controlPlane = verifyControllerControlPlaneReadback(expected, observed.controlPlane);
  const iam = verifyControllerIamReadback(
    createControllerIamDeploymentPlan(expected.deployment),
    observed.iam,
  );
  const firestore = verifyControllerFirestoreReadback(
    createControllerFirestoreDeploymentPlan(expected.deployment),
    observed.firestore,
  );
  return {
    controlPlane,
    environment: expected.deployment.manifest.environment,
    firestore,
    iam,
    projectId: expected.deployment.manifest.projectId,
  };
}
