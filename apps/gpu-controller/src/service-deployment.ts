import { z } from "zod";

import {
  firestoreDatabaseConfigurationSchema,
  firestoreSyntheticAuthorizationSchema,
} from "./firestore-control-store.js";
import { fixedPolicyConfigurationSchema } from "./provider.js";
import { controllerRuntimeConfigurationSchema } from "./runtime.js";

const controllerImageDigestSchema = z
  .string()
  .regex(
    /^asia-southeast1-docker\.pkg\.dev\/[a-z][a-z0-9-]{4,28}\/[a-z0-9._-]+\/[a-z0-9._-]+@sha256:[a-f0-9]{64}$/u,
  );
const controllerServiceAccountSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{4,28}@[a-z][a-z0-9-]{4,28}\.iam\.gserviceaccount\.com$/u);
const serviceNameSchema = z
  .string()
  .min(1)
  .max(49)
  .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/u);
const secretNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/u);
const secretVersionSchema = z.string().regex(/^[1-9][0-9]*$/u);

const secretReferenceSchema = z
  .object({
    name: secretNameSchema,
    version: secretVersionSchema,
  })
  .strict();

function hasEnvironmentMarker(value: string, environment: "staging" | "production"): boolean {
  return new RegExp(`(?:^|[-_])${environment}(?:[-_]|$)`, "u").test(value);
}

export const controllerServiceDeploymentConfigurationSchema = z
  .object({
    authorization: firestoreSyntheticAuthorizationSchema,
    controllerImageDigest: controllerImageDigestSchema,
    controllerServiceAccount: controllerServiceAccountSchema,
    firestore: firestoreDatabaseConfigurationSchema,
    manifest: fixedPolicyConfigurationSchema,
    primaryHmacSecret: secretReferenceSchema,
    secondaryHmacSecret: secretReferenceSchema.optional(),
    serviceName: serviceNameSchema,
  })
  .strict()
  .superRefine((configuration, context) => {
    const runtime = controllerRuntimeConfigurationSchema.safeParse({
      authorization: configuration.authorization,
      firestore: configuration.firestore,
      manifest: configuration.manifest,
    });
    if (!runtime.success) {
      context.addIssue({ code: "custom", message: "controller runtime configuration is invalid" });
    }
    const environment = configuration.manifest.environment;
    if (!hasEnvironmentMarker(configuration.serviceName, environment)) {
      context.addIssue({
        code: "custom",
        message: "controller service name must include its environment",
        path: ["serviceName"],
      });
    }
    const projectId = configuration.manifest.projectId;
    const imagePrefix = `asia-southeast1-docker.pkg.dev/${projectId}/`;
    if (!configuration.controllerImageDigest.startsWith(imagePrefix)) {
      context.addIssue({
        code: "custom",
        message: "controller image must belong to the configured project",
        path: ["controllerImageDigest"],
      });
    }
    if (!configuration.controllerServiceAccount.endsWith(`@${projectId}.iam.gserviceaccount.com`)) {
      context.addIssue({
        code: "custom",
        message: "controller service account must belong to the configured project",
        path: ["controllerServiceAccount"],
      });
    }
    if (!hasEnvironmentMarker(configuration.primaryHmacSecret.name, environment)) {
      context.addIssue({
        code: "custom",
        message: "primary HMAC secret must include its environment",
        path: ["primaryHmacSecret", "name"],
      });
    }
    if (
      configuration.secondaryHmacSecret !== undefined &&
      (!hasEnvironmentMarker(configuration.secondaryHmacSecret.name, environment) ||
        configuration.secondaryHmacSecret.name === configuration.primaryHmacSecret.name)
    ) {
      context.addIssue({
        code: "custom",
        message: "secondary HMAC secret must be distinct and include its environment",
        path: ["secondaryHmacSecret", "name"],
      });
    }
  });

const valueEnvironmentSchema = z.object({ name: z.string().min(1), value: z.string() }).strict();
const secretEnvironmentSchema = z
  .object({
    name: z.enum(["SCRIBE_DROP_CONTROLLER_HMAC_PRIMARY", "SCRIBE_DROP_CONTROLLER_HMAC_SECONDARY"]),
    valueSource: z
      .object({
        secretKeyRef: z.object({ secret: secretNameSchema, version: secretVersionSchema }).strict(),
      })
      .strict(),
  })
  .strict();

const requiredEnvironmentNames = [
  "APP_ENV",
  "SCRIBE_DROP_GCP_PROJECT_ID",
  "SCRIBE_DROP_FIRESTORE_DATABASE_ID",
  "SCRIBE_DROP_CLOUD_RUN_IMAGE_DIGEST",
  "SCRIBE_DROP_CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT",
  "SCRIBE_DROP_ORCHESTRATOR_ORIGIN",
  "SCRIBE_DROP_SOURCE_HOST",
  "SCRIBE_DROP_RESULT_HOST",
  "SCRIBE_DROP_AUTHORIZATION_EPOCH",
  "SCRIBE_DROP_AUTHORIZATION_VALID_UNTIL",
  "SCRIBE_DROP_AUTHORIZATION_MAX_EXECUTIONS",
  "SCRIBE_DROP_AUTHORIZATION_MAX_REQUESTS_PER_MINUTE",
  "SCRIBE_DROP_AUTHORIZATION_MAX_WORST_CASE_JPY",
  "SCRIBE_DROP_AUTHORIZATION_WORST_CASE_JPY_PER_EXECUTION",
  "SCRIBE_DROP_CONTROLLER_HMAC_PRIMARY",
] as const;
const allowedEnvironmentNames = new Set<string>([
  ...requiredEnvironmentNames,
  "SCRIBE_DROP_CONTROLLER_HMAC_SECONDARY",
]);

export const controllerServiceDeploymentPlanSchema = z
  .object({
    binaryAuthorization: z.object({ useDefault: z.literal(true) }).strict(),
    buildConfig: z.null(),
    customAudiences: z.tuple([]),
    defaultUriDisabled: z.literal(false),
    iapEnabled: z.literal(false),
    ingress: z.literal("INGRESS_TRAFFIC_ALL"),
    invokerIamDisabled: z.literal(true),
    labels: z
      .object({
        "scribe-drop-component": z.literal("gpu-controller"),
        "scribe-drop-environment": z.enum(["staging", "production"]),
        "scribe-drop-policy": z.literal("cloud-run-jobs-l4-v1"),
      })
      .strict(),
    launchStage: z.literal("GA"),
    multiRegionSettings: z.null(),
    name: z
      .string()
      .regex(
        /^projects\/[a-z][a-z0-9-]{4,28}\/locations\/asia-southeast1\/services\/[a-z][a-z0-9-]*[a-z0-9]$/u,
      ),
    scaling: z
      .object({
        maxInstanceCount: z.literal(1),
        minInstanceCount: z.literal(0),
        scalingMode: z.literal("AUTOMATIC"),
      })
      .strict(),
    template: z
      .object({
        containers: z.tuple([
          z
            .object({
              args: z.tuple([]),
              command: z.tuple([]),
              env: z.array(z.union([valueEnvironmentSchema, secretEnvironmentSchema])),
              image: controllerImageDigestSchema,
              name: z.literal("controller"),
              ports: z.tuple([
                z.object({ containerPort: z.literal(8080), name: z.literal("http1") }).strict(),
              ]),
              resources: z
                .object({
                  cpuIdle: z.literal(true),
                  limits: z.object({ cpu: z.literal("1"), memory: z.literal("512Mi") }).strict(),
                  startupCpuBoost: z.literal(false),
                })
                .strict(),
              volumeMounts: z.tuple([]),
            })
            .strict(),
        ]),
        encryptionKey: z.null(),
        executionEnvironment: z.literal("EXECUTION_ENVIRONMENT_GEN2"),
        healthCheckDisabled: z.literal(false),
        labels: z
          .object({
            "scribe-drop-component": z.literal("gpu-controller"),
            "scribe-drop-environment": z.enum(["staging", "production"]),
          })
          .strict(),
        maxInstanceRequestConcurrency: z.literal(8),
        scaling: z
          .object({ maxInstanceCount: z.literal(1), minInstanceCount: z.literal(0) })
          .strict(),
        serviceAccount: controllerServiceAccountSchema,
        sessionAffinity: z.literal(false),
        timeout: z.literal("60s"),
        volumes: z.tuple([]),
        vpcAccess: z.null(),
      })
      .strict(),
    traffic: z.tuple([
      z
        .object({
          percent: z.literal(100),
          type: z.literal("TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((plan, context) => {
    const names = plan.template.containers[0].env.map(({ name }) => name);
    const uniqueNames = new Set(names);
    if (uniqueNames.size !== names.length) {
      context.addIssue({
        code: "custom",
        message: "controller Service environment names must be unique",
        path: ["template", "containers", 0, "env"],
      });
    }
    if (
      requiredEnvironmentNames.some((name) => !uniqueNames.has(name)) ||
      names.some((name) => !allowedEnvironmentNames.has(name))
    ) {
      context.addIssue({
        code: "custom",
        message: "controller Service environment allowlist drifted",
        path: ["template", "containers", 0, "env"],
      });
    }
  });

export type ControllerServiceDeploymentConfiguration = z.infer<
  typeof controllerServiceDeploymentConfigurationSchema
>;
export type ControllerServiceDeploymentPlan = z.infer<typeof controllerServiceDeploymentPlanSchema>;

function authorizationEnvironment(
  authorization: ControllerServiceDeploymentConfiguration["authorization"],
): readonly { readonly name: string; readonly value: string }[] {
  return [
    { name: "SCRIBE_DROP_AUTHORIZATION_EPOCH", value: authorization.epoch },
    { name: "SCRIBE_DROP_AUTHORIZATION_VALID_UNTIL", value: authorization.validUntil },
    {
      name: "SCRIBE_DROP_AUTHORIZATION_MAX_EXECUTIONS",
      value: String(authorization.maxExecutions),
    },
    {
      name: "SCRIBE_DROP_AUTHORIZATION_MAX_REQUESTS_PER_MINUTE",
      value: String(authorization.maxRequestsPerMinute),
    },
    {
      name: "SCRIBE_DROP_AUTHORIZATION_MAX_WORST_CASE_JPY",
      value: String(authorization.maxWorstCaseJpy),
    },
    {
      name: "SCRIBE_DROP_AUTHORIZATION_WORST_CASE_JPY_PER_EXECUTION",
      value: String(authorization.worstCaseJpyPerExecution),
    },
  ];
}

export function createControllerServiceDeploymentPlan(
  configuration: ControllerServiceDeploymentConfiguration,
): ControllerServiceDeploymentPlan {
  const parsed = controllerServiceDeploymentConfigurationSchema.parse(configuration);
  const environment = parsed.manifest.environment;
  const labels = {
    "scribe-drop-component": "gpu-controller",
    "scribe-drop-environment": environment,
  } as const;
  const env = [
    { name: "APP_ENV", value: environment },
    { name: "SCRIBE_DROP_GCP_PROJECT_ID", value: parsed.manifest.projectId },
    { name: "SCRIBE_DROP_FIRESTORE_DATABASE_ID", value: parsed.firestore.databaseId },
    { name: "SCRIBE_DROP_CLOUD_RUN_IMAGE_DIGEST", value: parsed.manifest.imageDigest },
    {
      name: "SCRIBE_DROP_CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT",
      value: parsed.manifest.runtimeServiceAccount,
    },
    { name: "SCRIBE_DROP_ORCHESTRATOR_ORIGIN", value: parsed.manifest.orchestratorOrigin },
    { name: "SCRIBE_DROP_SOURCE_HOST", value: parsed.manifest.sourceHost },
    { name: "SCRIBE_DROP_RESULT_HOST", value: parsed.manifest.resultHost },
    ...authorizationEnvironment(parsed.authorization),
    {
      name: "SCRIBE_DROP_CONTROLLER_HMAC_PRIMARY",
      valueSource: {
        secretKeyRef: {
          secret: parsed.primaryHmacSecret.name,
          version: parsed.primaryHmacSecret.version,
        },
      },
    },
    ...(parsed.secondaryHmacSecret === undefined
      ? []
      : [
          {
            name: "SCRIBE_DROP_CONTROLLER_HMAC_SECONDARY" as const,
            valueSource: {
              secretKeyRef: {
                secret: parsed.secondaryHmacSecret.name,
                version: parsed.secondaryHmacSecret.version,
              },
            },
          },
        ]),
  ];
  return controllerServiceDeploymentPlanSchema.parse({
    binaryAuthorization: { useDefault: true },
    buildConfig: null,
    customAudiences: [],
    defaultUriDisabled: false,
    iapEnabled: false,
    ingress: "INGRESS_TRAFFIC_ALL",
    invokerIamDisabled: true,
    labels: { ...labels, "scribe-drop-policy": "cloud-run-jobs-l4-v1" },
    launchStage: "GA",
    multiRegionSettings: null,
    name: `projects/${parsed.manifest.projectId}/locations/asia-southeast1/services/${parsed.serviceName}`,
    scaling: { maxInstanceCount: 1, minInstanceCount: 0, scalingMode: "AUTOMATIC" },
    template: {
      containers: [
        {
          args: [],
          command: [],
          env,
          image: parsed.controllerImageDigest,
          name: "controller",
          ports: [{ containerPort: 8080, name: "http1" }],
          resources: {
            cpuIdle: true,
            limits: { cpu: "1", memory: "512Mi" },
            startupCpuBoost: false,
          },
          volumeMounts: [],
        },
      ],
      encryptionKey: null,
      executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
      healthCheckDisabled: false,
      labels,
      maxInstanceRequestConcurrency: 8,
      scaling: { maxInstanceCount: 1, minInstanceCount: 0 },
      serviceAccount: parsed.controllerServiceAccount,
      sessionAffinity: false,
      timeout: "60s",
      volumes: [],
      vpcAccess: null,
    },
    traffic: [{ percent: 100, type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST" }],
  });
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function verifyControllerServiceDeploymentReadback(
  expected: ControllerServiceDeploymentPlan,
  observed: unknown,
): void {
  const expectedPlan = controllerServiceDeploymentPlanSchema.parse(expected);
  const observedPlan = controllerServiceDeploymentPlanSchema.parse(observed);
  const normalizeEnvironmentOrder = (plan: ControllerServiceDeploymentPlan): unknown => ({
    ...plan,
    template: {
      ...plan.template,
      containers: [
        {
          ...plan.template.containers[0],
          env: [...plan.template.containers[0].env].sort((left, right) =>
            left.name.localeCompare(right.name),
          ),
        },
      ],
    },
  });
  if (
    canonicalize(normalizeEnvironmentOrder(expectedPlan)) !==
    canonicalize(normalizeEnvironmentOrder(observedPlan))
  ) {
    throw new Error("controller Service read-back does not match the deployment plan");
  }
}
