import { describe, expect, it } from "vitest";

import { defaultSyntheticAuthorizations } from "./control-store.js";
import {
  cloudRunControllerPermissions,
  createControllerIamDeploymentPlan,
  firestoreControllerPermissions,
  verifyControllerIamReadback,
  type ControllerIamRawReadback,
} from "./iam-deployment.js";
import type { ControllerServiceDeploymentConfiguration } from "./service-deployment.js";

const configuration: ControllerServiceDeploymentConfiguration = {
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
};

function rawIamReadback(): ControllerIamRawReadback {
  const plan = createControllerIamDeploymentPlan(configuration);
  return {
    artifactRepository: {
      iamPolicy: {
        bindings: [
          ...plan.artifactRepository.bindings,
          {
            members: ["serviceAccount:service-agent@example.iam.gserviceaccount.com"],
            role: "roles/artifactregistry.reader",
          },
        ],
        etag: "repository-iam-etag",
        version: 1,
      },
      resource: plan.artifactRepository.resource,
    },
    cloudRunRole: { ...plan.cloudRunRole, etag: "cloud-run-role-etag" },
    firestoreRole: { ...plan.firestoreRole, etag: "firestore-role-etag" },
    project: {
      iamPolicy: {
        auditConfigs: [
          {
            auditLogConfigs: [{ logType: "DATA_WRITE" }],
            service: "allServices",
          },
        ],
        bindings: [
          {
            members: ["user:operator@example.test"],
            role: "roles/viewer",
          },
          ...plan.projectBindings,
        ],
        etag: "project-iam-etag",
        version: 3,
      },
      resource: plan.projectResource,
    },
    runtimeServiceAccount: {
      iamPolicy: {
        bindings: [...plan.runtimeServiceAccount.bindings],
        etag: "runtime-iam-etag",
        version: 1,
      },
      resource: plan.runtimeServiceAccount.resource,
    },
  };
}

describe("controller IAM deployment policy", () => {
  it("splits exact permissions and bindings by resource boundary", () => {
    const plan = createControllerIamDeploymentPlan(configuration);

    expect(plan.cloudRunRole.includedPermissions).toEqual(cloudRunControllerPermissions);
    expect(plan.cloudRunRole.includedPermissions).not.toContain("run.jobs.update");
    expect(plan.cloudRunRole.includedPermissions).not.toContain("run.jobs.runWithOverrides");
    expect(plan.cloudRunRole.includedPermissions).not.toContain("run.jobs.list");
    expect(plan.cloudRunRole.includedPermissions).not.toContain("run.executions.get");
    expect(plan.firestoreRole.includedPermissions).toEqual(firestoreControllerPermissions);
    expect(plan.projectBindings[1].condition?.expression).toBe(
      'resource.name == "projects/scribe-phase14/databases/scribe-staging-controller"',
    );
    expect(plan.artifactRepository).toEqual({
      bindings: [
        {
          members: ["serviceAccount:gpu-controller@scribe-phase14.iam.gserviceaccount.com"],
          role: "roles/artifactregistry.reader",
        },
      ],
      resource: "projects/scribe-phase14/locations/asia-southeast1/repositories/worker",
    });
    expect(plan.runtimeServiceAccount.bindings[0].role).toBe("roles/iam.serviceAccountUser");
  });

  it("accepts unrelated principals but verifies every controller grant exactly", () => {
    const plan = createControllerIamDeploymentPlan(configuration);
    const observed = rawIamReadback();
    const projectBindings = observed.project.iamPolicy.bindings;
    if (projectBindings === undefined) throw new Error("project IAM fixture is incomplete");
    const controllerBinding = projectBindings[1];
    if (controllerBinding === undefined) throw new Error("project IAM fixture is incomplete");
    controllerBinding.members.push("user:operator@example.test");
    const evidence = verifyControllerIamReadback(plan, observed);

    expect(evidence).toEqual({
      artifactRepository: { etag: "repository-iam-etag", version: 1 },
      cloudRunRole: { etag: "cloud-run-role-etag" },
      firestoreRole: { etag: "firestore-role-etag" },
      project: { etag: "project-iam-etag", version: 3 },
      runtimeServiceAccount: { etag: "runtime-iam-etag", version: 1 },
    });
  });

  it("accepts live custom role output that omits deleted false", () => {
    const plan = createControllerIamDeploymentPlan(configuration);
    const observed = rawIamReadback();
    delete observed.cloudRunRole.deleted;
    delete observed.firestoreRole.deleted;

    expect(() => verifyControllerIamReadback(plan, observed)).not.toThrow();
  });

  it("rejects excess roles, role drift, and database-condition drift", () => {
    const plan = createControllerIamDeploymentPlan(configuration);
    const excess = rawIamReadback();
    const excessBindings = excess.project.iamPolicy.bindings;
    if (excessBindings === undefined) throw new Error("project IAM fixture is incomplete");
    excessBindings.push({
      members: [plan.controllerPrincipal],
      role: "roles/owner",
    });
    expect(() => verifyControllerIamReadback(plan, excess)).toThrow();

    const roleDrift = rawIamReadback();
    roleDrift.cloudRunRole.includedPermissions.push("run.jobs.update");
    expect(() => verifyControllerIamReadback(plan, roleDrift)).toThrow();

    const conditionDrift = rawIamReadback();
    const conditionBindings = conditionDrift.project.iamPolicy.bindings;
    if (conditionBindings === undefined) throw new Error("project IAM fixture is incomplete");
    const firestoreBinding = conditionBindings[2];
    if (firestoreBinding?.condition === undefined) {
      throw new Error("Firestore IAM condition fixture is missing");
    }
    firestoreBinding.condition.expression =
      'resource.name == "projects/scribe-phase14/databases/(default)"';
    expect(() => verifyControllerIamReadback(plan, conditionDrift)).toThrow();

    const wrongResource = rawIamReadback();
    wrongResource.artifactRepository.resource =
      "projects/scribe-phase14/locations/asia-southeast1/repositories/other";
    expect(() => verifyControllerIamReadback(plan, wrongResource)).toThrow();
  });

  it("rejects a broadened expectation or cross-project resource before observation", () => {
    const broadened = structuredClone(createControllerIamDeploymentPlan(configuration));
    broadened.cloudRunRole.includedPermissions.push("run.jobs.update");
    expect(() => verifyControllerIamReadback(broadened, rawIamReadback())).toThrow(
      "controller custom IAM roles drifted",
    );

    const crossProject = structuredClone(createControllerIamDeploymentPlan(configuration));
    crossProject.runtimeServiceAccount.resource =
      "projects/other-project/serviceAccounts/gpu-runtime@other-project.iam.gserviceaccount.com";
    expect(() => verifyControllerIamReadback(crossProject, rawIamReadback())).toThrow(
      "runtime identity resource drifted",
    );
  });
});
