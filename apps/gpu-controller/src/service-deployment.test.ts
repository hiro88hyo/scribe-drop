import { describe, expect, it } from "vitest";

import { defaultSyntheticAuthorizations } from "./control-store.js";
import {
  createControllerServiceDeploymentPlan,
  verifyControllerServiceDeploymentReadback,
  type ControllerServiceDeploymentConfiguration,
} from "./service-deployment.js";

const configuration: ControllerServiceDeploymentConfiguration = {
  authorization: defaultSyntheticAuthorizations().staging,
  controllerImageDigest: `asia-southeast1-docker.pkg.dev/scribe-phase14/controller/runtime@sha256:${"b".repeat(64)}`,
  controllerServiceAccount: "gpu-controller@scribe-phase14.iam.gserviceaccount.com",
  firestore: {
    databaseId: "scribe-staging-controller",
    projectId: "scribe-phase14",
  },
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
  secondaryHmacSecret: { name: "scribe-drop-staging-controller-secondary", version: "3" },
  serviceName: "scribe-drop-staging-gpu-controller",
};

describe("controller Service deployment policy", () => {
  it("creates an exact zero-budget, bounded, authenticated-image plan", () => {
    const plan = createControllerServiceDeploymentPlan(configuration);

    expect(plan.name).toBe(
      "projects/scribe-phase14/locations/asia-southeast1/services/scribe-drop-staging-gpu-controller",
    );
    expect(plan.binaryAuthorization).toEqual({ useDefault: true });
    expect(plan.invokerIamDisabled).toBe(true);
    expect(plan.defaultUriDisabled).toBe(false);
    expect(plan.scaling).toEqual({
      maxInstanceCount: 1,
      minInstanceCount: 0,
      scalingMode: "AUTOMATIC",
    });
    expect(plan.template.maxInstanceRequestConcurrency).toBe(8);
    expect(plan.template.containers[0].resources).toEqual({
      cpuIdle: true,
      limits: { cpu: "1", memory: "512Mi" },
      startupCpuBoost: false,
    });
    expect(plan.template.containers[0].env).toContainEqual({
      name: "SCRIBE_DROP_AUTHORIZATION_MAX_EXECUTIONS",
      value: "0",
    });
    expect(plan.template.containers[0].env).toContainEqual({
      name: "SCRIBE_DROP_CONTROLLER_HMAC_PRIMARY",
      valueSource: {
        secretKeyRef: {
          secret: "scribe-drop-staging-controller-primary",
          version: "7",
        },
      },
    });
    expect(() => {
      verifyControllerServiceDeploymentReadback(plan, structuredClone(plan));
    }).not.toThrow();
    const reordered = structuredClone(plan);
    reordered.template.containers[0].env.reverse();
    expect(() => {
      verifyControllerServiceDeploymentReadback(plan, reordered);
    }).not.toThrow();
  });

  it("rejects mutable images, cross-environment resources, and floating secrets", () => {
    expect(() => {
      createControllerServiceDeploymentPlan({
        ...configuration,
        controllerImageDigest:
          "asia-southeast1-docker.pkg.dev/scribe-phase14/controller/runtime:latest",
      });
    }).toThrow();
    expect(() => {
      createControllerServiceDeploymentPlan({
        ...configuration,
        controllerServiceAccount: "gpu-controller@scribe-other14.iam.gserviceaccount.com",
      });
    }).toThrow();
    expect(() => {
      createControllerServiceDeploymentPlan({
        ...configuration,
        primaryHmacSecret: { ...configuration.primaryHmacSecret, version: "latest" },
      });
    }).toThrow();
    expect(() => {
      createControllerServiceDeploymentPlan({
        ...configuration,
        serviceName: "scribe-drop-production-gpu-controller",
      });
    }).toThrow();
  });

  it("fails closed on scaling, identity, traffic, or environment read-back drift", () => {
    const plan = createControllerServiceDeploymentPlan(configuration);
    const firstEnvironment = plan.template.containers[0].env[0];
    if (firstEnvironment === undefined) throw new Error("deployment plan environment is empty");
    const drifts = [
      { ...structuredClone(plan), invokerIamDisabled: false },
      { ...structuredClone(plan), scaling: { ...plan.scaling, maxInstanceCount: 2 } },
      {
        ...structuredClone(plan),
        template: { ...plan.template, serviceAccount: "default@developer.gserviceaccount.com" },
      },
      { ...structuredClone(plan), traffic: [{ percent: 50, type: plan.traffic[0].type }] },
      {
        ...structuredClone(plan),
        template: {
          ...plan.template,
          containers: [
            {
              ...plan.template.containers[0],
              env: [
                ...plan.template.containers[0].env,
                { name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/key.json" },
              ],
            },
          ],
        },
      },
      {
        ...structuredClone(plan),
        template: {
          ...plan.template,
          containers: [
            {
              ...plan.template.containers[0],
              env: [...plan.template.containers[0].env, firstEnvironment],
            },
          ],
        },
      },
    ];
    for (const drift of drifts) {
      expect(() => {
        verifyControllerServiceDeploymentReadback(plan, drift);
      }).toThrow();
    }
  });
});
