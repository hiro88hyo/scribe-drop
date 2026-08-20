import { describe, expect, it } from "vitest";

import { defaultSyntheticAuthorizations } from "./control-store.js";
import {
  createControllerServiceDeploymentPlan,
  type ControllerServiceDeploymentConfiguration,
  type ControllerServiceDeploymentPlan,
} from "./service-deployment.js";
import { verifyCloudRunV2ControllerServiceReadback } from "./service-readback.js";

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
  secondaryHmacSecret: { name: "scribe-drop-staging-controller-secondary", version: "3" },
  serviceName: "scribe-drop-staging-gpu-controller",
};

function rawServiceFromPlan(plan: ControllerServiceDeploymentPlan): Record<string, unknown> {
  const revision = "scribe-drop-staging-gpu-controller-00001-abc";
  const uri = "https://scribe-drop-staging-gpu-controller-abcdef-as.a.run.app/";
  return {
    binaryAuthorization: { useDefault: true },
    conditions: [{ state: "CONDITION_SUCCEEDED", type: "Ready" }],
    createTime: "2026-08-11T00:00:00Z",
    etag: "BwYAAABexample=",
    generation: "1",
    ingress: plan.ingress,
    invokerIamDisabled: plan.invokerIamDisabled,
    labels: plan.labels,
    latestCreatedRevision: revision,
    latestReadyRevision: revision,
    launchStage: plan.launchStage,
    name: plan.name,
    observedGeneration: "1",
    sshEnabled: false,
    scaling: plan.scaling,
    template: {
      containers: plan.template.containers.map((container) => ({
        ...container,
        startupProbe: {
          failureThreshold: 1,
          periodSeconds: 240,
          tcpSocket: { port: 8080 },
          timeoutSeconds: 240,
        },
      })),
      executionEnvironment: plan.template.executionEnvironment,
      healthCheckDisabled: plan.template.healthCheckDisabled,
      labels: plan.template.labels,
      maxInstanceRequestConcurrency: plan.template.maxInstanceRequestConcurrency,
      scaling: plan.template.scaling,
      serviceAccount: plan.template.serviceAccount,
      sessionAffinity: plan.template.sessionAffinity,
      timeout: plan.template.timeout,
      volumes: [],
    },
    terminalCondition: { state: "CONDITION_SUCCEEDED", type: "Ready" },
    threatDetectionEnabled: true,
    traffic: plan.traffic,
    trafficStatuses: [
      {
        percent: 100,
        revision,
        type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST",
        uri,
      },
    ],
    uid: "123e4567-e89b-42d3-a456-426614174000",
    updateTime: "2026-08-11T00:01:00Z",
    uri,
    urls: [uri],
  };
}

describe("Cloud Run v2 controller Service read-back", () => {
  it("normalizes documented defaults and returns non-secret output evidence", () => {
    const plan = createControllerServiceDeploymentPlan(configuration);
    const observed = rawServiceFromPlan(plan);
    const trafficStatuses = observed["trafficStatuses"] as { revision?: string }[];
    delete trafficStatuses[0]?.revision;
    const evidence = verifyCloudRunV2ControllerServiceReadback(plan, observed);

    expect(evidence).toEqual({
      createTime: "2026-08-11T00:00:00Z",
      etag: "BwYAAABexample=",
      generation: "1",
      threatDetectionEnabled: true,
      uid: "123e4567-e89b-42d3-a456-426614174000",
      updateTime: "2026-08-11T00:01:00Z",
      uri: "https://scribe-drop-staging-gpu-controller-abcdef-as.a.run.app/",
      urls: ["https://scribe-drop-staging-gpu-controller-abcdef-as.a.run.app/"],
    });
  });

  it("fails closed on stale readiness, traffic, image, or unknown provider fields", () => {
    const plan = createControllerServiceDeploymentPlan(configuration);
    const stale = rawServiceFromPlan(plan);
    stale["observedGeneration"] = "2";
    expect(() => verifyCloudRunV2ControllerServiceReadback(plan, stale)).toThrow();

    const reconciling = rawServiceFromPlan(plan);
    reconciling["reconciling"] = true;
    expect(() => verifyCloudRunV2ControllerServiceReadback(plan, reconciling)).toThrow();

    const sshEnabled = rawServiceFromPlan(plan);
    sshEnabled["sshEnabled"] = true;
    expect(() => verifyCloudRunV2ControllerServiceReadback(plan, sshEnabled)).toThrow();

    const probeDrift = rawServiceFromPlan(plan);
    const probeTemplate = structuredClone(probeDrift["template"]) as {
      containers: { startupProbe: { periodSeconds: number } }[];
    };
    const probeContainer = probeTemplate.containers[0];
    if (probeContainer === undefined) throw new Error("fixture container missing");
    probeContainer.startupProbe.periodSeconds = 30;
    probeDrift["template"] = probeTemplate;
    expect(() => verifyCloudRunV2ControllerServiceReadback(plan, probeDrift)).toThrow();

    const trafficDrift = rawServiceFromPlan(plan);
    trafficDrift["trafficStatuses"] = [];
    expect(() => verifyCloudRunV2ControllerServiceReadback(plan, trafficDrift)).toThrow();

    const imageDrift = rawServiceFromPlan(plan);
    const template = structuredClone(imageDrift["template"]) as {
      containers: { image: string }[];
    };
    const container = template.containers[0];
    if (container === undefined) throw new Error("fixture container missing");
    container.image = `asia-southeast1-docker.pkg.dev/scribe-phase14/controller/runtime@sha256:${"c".repeat(64)}`;
    imageDrift["template"] = template;
    expect(() => verifyCloudRunV2ControllerServiceReadback(plan, imageDrift)).toThrow();

    const unknown = rawServiceFromPlan(plan);
    unknown["futureProviderField"] = true;
    expect(() => verifyCloudRunV2ControllerServiceReadback(plan, unknown)).toThrow();
  });

  it("rejects breakglass, annotations, non-root URLs, and deleted Services", () => {
    const plan = createControllerServiceDeploymentPlan(configuration);
    const breakglass = rawServiceFromPlan(plan);
    breakglass["binaryAuthorization"] = {
      breakglassJustification: "emergency",
      useDefault: true,
    };
    expect(() => verifyCloudRunV2ControllerServiceReadback(plan, breakglass)).toThrow();

    const annotated = rawServiceFromPlan(plan);
    annotated["annotations"] = { "run.googleapis.com/example": "drift" };
    expect(() => verifyCloudRunV2ControllerServiceReadback(plan, annotated)).toThrow();

    const unsafeUrl = rawServiceFromPlan(plan);
    unsafeUrl["uri"] = "https://example.test/path?token=redacted";
    expect(() => verifyCloudRunV2ControllerServiceReadback(plan, unsafeUrl)).toThrow();

    const deleted = rawServiceFromPlan(plan);
    deleted["deleteTime"] = "2026-08-11T00:02:00Z";
    expect(() => verifyCloudRunV2ControllerServiceReadback(plan, deleted)).toThrow();
  });
});
