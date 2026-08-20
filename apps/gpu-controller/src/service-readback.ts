import { z } from "zod";

import {
  controllerServiceDeploymentPlanSchema,
  verifyControllerServiceDeploymentReadback,
  type ControllerServiceDeploymentPlan,
} from "./service-deployment.js";

const timestampSchema = z.iso.datetime({ offset: true });
const int64Schema = z.string().regex(/^[1-9][0-9]*$/u);
const boundedOutputStringSchema = z.string().max(4096);
const outputEtagSchema = z.string().min(1).max(1024);
const stringMapSchema = z.record(z.string().min(1).max(128), z.string().max(256));

const conditionSchema = z
  .object({
    executionReason: boundedOutputStringSchema.optional(),
    lastTransitionTime: timestampSchema.optional(),
    message: boundedOutputStringSchema.optional(),
    reason: boundedOutputStringSchema.optional(),
    revisionReason: boundedOutputStringSchema.optional(),
    severity: z.enum(["CONDITION_SEVERITY_UNSPECIFIED", "ERROR", "WARNING", "INFO"]).optional(),
    state: z.enum([
      "STATE_UNSPECIFIED",
      "CONDITION_PENDING",
      "CONDITION_RECONCILING",
      "CONDITION_FAILED",
      "CONDITION_SUCCEEDED",
    ]),
    type: boundedOutputStringSchema.optional(),
  })
  .strict();

const secretKeyReferenceSchema = z
  .object({
    secret: z.string().min(1).max(255),
    version: z.string().regex(/^[1-9][0-9]*$/u),
  })
  .strict();

const environmentVariableSchema = z.union([
  z.object({ name: z.string().min(1).max(32768), value: z.string() }).strict(),
  z
    .object({
      name: z.string().min(1).max(32768),
      valueSource: z.object({ secretKeyRef: secretKeyReferenceSchema }).strict(),
    })
    .strict(),
]);

const defaultStartupProbeSchema = z
  .object({
    failureThreshold: z.literal(1),
    periodSeconds: z.literal(240),
    tcpSocket: z.object({ port: z.literal(8080) }).strict(),
    timeoutSeconds: z.literal(240),
  })
  .strict();

const containerSchema = z
  .object({
    args: z.array(z.string()).optional(),
    baseImageUri: z.never().optional(),
    buildInfo: z.never().optional(),
    command: z.array(z.string()).optional(),
    dependsOn: z.array(z.string()).optional(),
    env: z.array(environmentVariableSchema).optional(),
    image: z.string().min(1),
    livenessProbe: z.never().optional(),
    name: z.string().min(1),
    ports: z
      .array(
        z
          .object({
            containerPort: z.number().int().min(1).max(65535),
            name: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
    readinessProbe: z.never().optional(),
    resources: z
      .object({
        cpuIdle: z.boolean().optional(),
        limits: z.record(z.string().min(1), z.string().min(1)).optional(),
        startupCpuBoost: z.boolean().optional(),
      })
      .strict()
      .optional(),
    sourceCode: z.never().optional(),
    startupProbe: defaultStartupProbeSchema.optional(),
    volumeMounts: z.array(z.never()).optional(),
    workingDir: z.never().optional(),
  })
  .strict();

const revisionTemplateSchema = z
  .object({
    annotations: stringMapSchema.optional(),
    client: boundedOutputStringSchema.optional(),
    clientVersion: boundedOutputStringSchema.optional(),
    containers: z.array(containerSchema),
    encryptionKey: z.never().optional(),
    encryptionKeyRevocationAction: z.never().optional(),
    encryptionKeyShutdownDuration: z.never().optional(),
    executionEnvironment: z.enum([
      "EXECUTION_ENVIRONMENT_UNSPECIFIED",
      "EXECUTION_ENVIRONMENT_GEN1",
      "EXECUTION_ENVIRONMENT_GEN2",
    ]),
    gpuZonalRedundancyDisabled: z.boolean().optional(),
    healthCheckDisabled: z.boolean().optional(),
    labels: stringMapSchema.optional(),
    maxInstanceRequestConcurrency: z.number().int().min(0),
    nodeSelector: z.never().optional(),
    revision: boundedOutputStringSchema.optional(),
    scaling: z
      .object({
        maxInstanceCount: z.number().int().min(0).optional(),
        minInstanceCount: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
    serviceAccount: z.string().min(1),
    serviceMesh: z.never().optional(),
    sessionAffinity: z.boolean().optional(),
    timeout: z.string().regex(/^[0-9]+(?:\.[0-9]{1,9})?s$/u),
    volumes: z.array(z.never()).optional(),
    vpcAccess: z.never().optional(),
  })
  .strict();

const trafficTargetSchema = z
  .object({
    percent: z.number().int().min(0).max(100).optional(),
    revision: boundedOutputStringSchema.optional(),
    tag: boundedOutputStringSchema.optional(),
    type: z.enum([
      "TRAFFIC_TARGET_ALLOCATION_TYPE_UNSPECIFIED",
      "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST",
      "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
    ]),
  })
  .strict();

const serviceUrlSchema = z.url().superRefine((value, context) => {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !parsed.hostname.endsWith(".run.app")
  ) {
    context.addIssue({ code: "custom", message: "Cloud Run URL must be a root HTTPS run.app URL" });
  }
});

const trafficStatusSchema = z
  .object({
    percent: z.number().int().min(0).max(100),
    revision: boundedOutputStringSchema.optional(),
    tag: boundedOutputStringSchema.optional(),
    type: z.enum([
      "TRAFFIC_TARGET_ALLOCATION_TYPE_UNSPECIFIED",
      "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST",
      "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION",
    ]),
    uri: serviceUrlSchema.optional(),
  })
  .strict();

export const cloudRunV2ControllerServiceReadbackSchema = z
  .object({
    annotations: stringMapSchema.optional(),
    binaryAuthorization: z
      .object({
        breakglassJustification: z.literal("").optional(),
        policy: z.never().optional(),
        useDefault: z.literal(true),
      })
      .strict(),
    buildConfig: z.never().optional(),
    client: boundedOutputStringSchema.optional(),
    clientVersion: boundedOutputStringSchema.optional(),
    conditions: z.array(conditionSchema),
    createTime: timestampSchema,
    creator: boundedOutputStringSchema.optional(),
    customAudiences: z.array(z.string()).optional(),
    defaultUriDisabled: z.boolean().optional(),
    deleteTime: timestampSchema.optional(),
    description: boundedOutputStringSchema.optional(),
    etag: outputEtagSchema,
    expireTime: timestampSchema.optional(),
    generation: int64Schema,
    iapEnabled: z.boolean().optional(),
    ingress: z.enum([
      "INGRESS_TRAFFIC_UNSPECIFIED",
      "INGRESS_TRAFFIC_ALL",
      "INGRESS_TRAFFIC_INTERNAL_ONLY",
      "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
      "INGRESS_TRAFFIC_NONE",
    ]),
    invokerIamDisabled: z.boolean().optional(),
    labels: stringMapSchema.optional(),
    lastModifier: boundedOutputStringSchema.optional(),
    latestCreatedRevision: boundedOutputStringSchema,
    latestReadyRevision: boundedOutputStringSchema,
    launchStage: z.enum([
      "LAUNCH_STAGE_UNSPECIFIED",
      "UNIMPLEMENTED",
      "PRELAUNCH",
      "EARLY_ACCESS",
      "ALPHA",
      "BETA",
      "GA",
      "DEPRECATED",
    ]),
    multiRegionSettings: z.never().optional(),
    name: z.string().min(1),
    observedGeneration: int64Schema,
    reconciling: z.literal(false).optional(),
    satisfiesPzs: z.boolean().optional(),
    scaling: z
      .object({
        manualInstanceCount: z.never().optional(),
        maxInstanceCount: z.number().int().min(0).optional(),
        minInstanceCount: z.number().int().min(0).optional(),
        scalingMode: z.enum(["SCALING_MODE_UNSPECIFIED", "AUTOMATIC", "MANUAL"]).optional(),
      })
      .strict()
      .optional(),
    sshEnabled: z.literal(false).optional(),
    template: revisionTemplateSchema,
    terminalCondition: conditionSchema,
    threatDetectionEnabled: z.boolean().optional(),
    traffic: z.array(trafficTargetSchema).optional(),
    trafficStatuses: z.array(trafficStatusSchema),
    uid: z.uuid(),
    updateTime: timestampSchema,
    uri: serviceUrlSchema,
    urls: z.array(serviceUrlSchema),
  })
  .strict()
  .superRefine((service, context) => {
    if (service.generation !== service.observedGeneration) {
      context.addIssue({ code: "custom", message: "Cloud Run observed generation is stale" });
    }
    if (service.terminalCondition.state !== "CONDITION_SUCCEEDED") {
      context.addIssue({
        code: "custom",
        message: "Cloud Run terminal condition is not successful",
      });
    }
    if (service.latestReadyRevision !== service.latestCreatedRevision) {
      context.addIssue({ code: "custom", message: "latest Cloud Run revision is not ready" });
    }
    if (service.deleteTime !== undefined || service.expireTime !== undefined) {
      context.addIssue({ code: "custom", message: "Cloud Run Service is deleted or expiring" });
    }
    if (service.annotations !== undefined && Object.keys(service.annotations).length !== 0) {
      context.addIssue({
        code: "custom",
        message: "Cloud Run Service annotations are not allowed",
      });
    }
    if (
      service.template.annotations !== undefined &&
      Object.keys(service.template.annotations).length !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Cloud Run revision annotations are not allowed",
      });
    }
    if (service.template.gpuZonalRedundancyDisabled === true) {
      context.addIssue({
        code: "custom",
        message: "controller Service must not carry GPU settings",
      });
    }
    if (new Set(service.urls).size !== service.urls.length || !service.urls.includes(service.uri)) {
      context.addIssue({ code: "custom", message: "Cloud Run canonical URI is absent from URLs" });
    }
    if (
      service.trafficStatuses.length !== 1 ||
      service.trafficStatuses[0]?.type !== "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST" ||
      service.trafficStatuses[0].percent !== 100 ||
      (service.trafficStatuses[0].revision !== undefined &&
        service.trafficStatuses[0].revision !== service.latestReadyRevision) ||
      service.trafficStatuses[0].tag !== undefined
    ) {
      context.addIssue({ code: "custom", message: "Cloud Run traffic status is not latest-only" });
    }
  });

export type CloudRunV2ControllerServiceReadback = z.infer<
  typeof cloudRunV2ControllerServiceReadbackSchema
>;

export interface ControllerServiceReadbackEvidence {
  readonly createTime: string;
  readonly etag: string;
  readonly generation: string;
  readonly threatDetectionEnabled: boolean | undefined;
  readonly uid: string;
  readonly updateTime: string;
  readonly uri: string;
  readonly urls: readonly string[];
}

function normalizeControllerServiceReadback(
  service: CloudRunV2ControllerServiceReadback,
): ControllerServiceDeploymentPlan {
  const container = service.template.containers[0];
  if (service.template.containers.length !== 1 || container === undefined) {
    throw new Error("controller Service must contain exactly one container");
  }
  return controllerServiceDeploymentPlanSchema.parse({
    binaryAuthorization: { useDefault: service.binaryAuthorization.useDefault },
    buildConfig: null,
    customAudiences: service.customAudiences ?? [],
    defaultUriDisabled: service.defaultUriDisabled ?? false,
    iapEnabled: service.iapEnabled ?? false,
    ingress: service.ingress,
    invokerIamDisabled: service.invokerIamDisabled ?? false,
    labels: service.labels ?? {},
    launchStage: service.launchStage,
    multiRegionSettings: null,
    name: service.name,
    scaling: {
      maxInstanceCount: service.scaling?.maxInstanceCount ?? 0,
      minInstanceCount: service.scaling?.minInstanceCount ?? 0,
      scalingMode: service.scaling?.scalingMode ?? "AUTOMATIC",
    },
    template: {
      containers: [
        {
          args: container.args ?? [],
          command: container.command ?? [],
          env: container.env ?? [],
          image: container.image,
          name: container.name,
          ports: container.ports ?? [],
          resources: {
            cpuIdle: container.resources?.cpuIdle ?? false,
            limits: container.resources?.limits ?? {},
            startupCpuBoost: container.resources?.startupCpuBoost ?? false,
          },
          volumeMounts: container.volumeMounts ?? [],
        },
      ],
      encryptionKey: null,
      executionEnvironment: service.template.executionEnvironment,
      healthCheckDisabled: service.template.healthCheckDisabled ?? false,
      labels: service.template.labels ?? {},
      maxInstanceRequestConcurrency: service.template.maxInstanceRequestConcurrency,
      scaling: {
        maxInstanceCount: service.template.scaling?.maxInstanceCount ?? 0,
        minInstanceCount: service.template.scaling?.minInstanceCount ?? 0,
      },
      serviceAccount: service.template.serviceAccount,
      sessionAffinity: service.template.sessionAffinity ?? false,
      timeout: service.template.timeout,
      volumes: service.template.volumes ?? [],
      vpcAccess: null,
    },
    traffic: service.traffic ?? [],
  });
}

export function verifyCloudRunV2ControllerServiceReadback(
  expected: ControllerServiceDeploymentPlan,
  rawReadback: unknown,
): ControllerServiceReadbackEvidence {
  const service = cloudRunV2ControllerServiceReadbackSchema.parse(rawReadback);
  verifyControllerServiceDeploymentReadback(expected, normalizeControllerServiceReadback(service));
  return {
    createTime: service.createTime,
    etag: service.etag,
    generation: service.generation,
    threatDetectionEnabled: service.threatDetectionEnabled,
    uid: service.uid,
    updateTime: service.updateTime,
    uri: service.uri,
    urls: service.urls,
  };
}
