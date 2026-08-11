import { z } from "zod";

import { CONTROLLER_POLICY_ID, type ControllerEnvironment } from "./contracts.js";

const digestImageSchema = z
  .string()
  .regex(
    /^asia-southeast1-docker\.pkg\.dev\/[a-z][a-z0-9-]{4,28}\/[a-z0-9._-]+\/[a-z0-9._-]+@sha256:[a-f0-9]{64}$/u,
  );
const serviceAccountSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{4,28}@[a-z][a-z0-9-]{4,28}\.iam\.gserviceaccount\.com$/u);
const projectSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}$/u);
const originSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" && url.username === "" && url.password === "" && url.pathname === "/"
  );
});
const exactHostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u)
  .refine((value) => !value.includes(".."));

export const fixedPolicyConfigurationSchema = z
  .object({
    environment: z.enum(["staging", "production"]),
    projectId: projectSchema,
    imageDigest: digestImageSchema,
    runtimeServiceAccount: serviceAccountSchema,
    orchestratorOrigin: originSchema,
    resultHost: exactHostnameSchema,
    sourceHost: exactHostnameSchema,
  })
  .strict();

export type FixedPolicyConfiguration = z.infer<typeof fixedPolicyConfigurationSchema>;

export interface CloudRunJobManifest {
  readonly labels: Readonly<Record<string, string>>;
  readonly template: {
    readonly taskCount: 1;
    readonly parallelism: 1;
    readonly template: {
      readonly containers: readonly [
        {
          readonly name: "worker";
          readonly image: string;
          readonly command: readonly ["python", "-m", "scribe_drop_worker.one_shot"];
          readonly env: readonly [
            { readonly name: "APP_ENV"; readonly value: ControllerEnvironment },
            { readonly name: "SCRIBE_DROP_BOOTSTRAP_REQUEST_ID"; readonly value: string },
            { readonly name: "SCRIBE_DROP_EXECUTION_HANDLE"; readonly value: string },
            {
              readonly name: "SCRIBE_DROP_EXECUTION_POLICY";
              readonly value: typeof CONTROLLER_POLICY_ID;
            },
            { readonly name: "SCRIBE_DROP_ORCHESTRATOR_ORIGIN"; readonly value: string },
            { readonly name: "SCRIBE_DROP_IDENTITY_AUDIENCE"; readonly value: string },
            { readonly name: "SCRIBE_DROP_SOURCE_HOST"; readonly value: string },
            { readonly name: "SCRIBE_DROP_RESULT_HOST"; readonly value: string },
          ];
          readonly resources: {
            readonly limits: {
              readonly cpu: "4";
              readonly memory: "16Gi";
              readonly "nvidia.com/gpu": "1";
            };
          };
          readonly volumeMounts: readonly [
            { readonly name: "scratch"; readonly mountPath: "/tmp" },
          ];
        },
      ];
      readonly volumes: readonly [
        {
          readonly name: "scratch";
          readonly emptyDir: { readonly medium: "MEMORY"; readonly sizeLimit: "3Gi" };
        },
      ];
      readonly timeout: "3300s";
      readonly serviceAccount: string;
      readonly executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2";
      readonly nodeSelector: { readonly accelerator: "nvidia-l4" };
      readonly maxRetries: 0;
      readonly gpuZonalRedundancyDisabled: true;
    };
  };
}

export function createFixedJobManifest(
  configuration: FixedPolicyConfiguration,
  executionHandle: string,
  bootstrapRequestId: string,
): CloudRunJobManifest {
  const parsed = fixedPolicyConfigurationSchema.parse(configuration);
  return {
    labels: {
      "scribe-drop-environment": parsed.environment,
      "scribe-drop-policy": "cloud-run-jobs-l4-v1",
    },
    template: {
      taskCount: 1,
      parallelism: 1,
      template: {
        containers: [
          {
            name: "worker",
            image: parsed.imageDigest,
            command: ["python", "-m", "scribe_drop_worker.one_shot"],
            env: [
              { name: "APP_ENV", value: parsed.environment },
              { name: "SCRIBE_DROP_BOOTSTRAP_REQUEST_ID", value: bootstrapRequestId },
              { name: "SCRIBE_DROP_EXECUTION_HANDLE", value: executionHandle },
              { name: "SCRIBE_DROP_EXECUTION_POLICY", value: CONTROLLER_POLICY_ID },
              { name: "SCRIBE_DROP_ORCHESTRATOR_ORIGIN", value: parsed.orchestratorOrigin },
              {
                name: "SCRIBE_DROP_IDENTITY_AUDIENCE",
                value: `${parsed.orchestratorOrigin}internal/cloud-run/bootstrap`,
              },
              { name: "SCRIBE_DROP_SOURCE_HOST", value: parsed.sourceHost },
              { name: "SCRIBE_DROP_RESULT_HOST", value: parsed.resultHost },
            ],
            resources: { limits: { cpu: "4", memory: "16Gi", "nvidia.com/gpu": "1" } },
            volumeMounts: [{ name: "scratch", mountPath: "/tmp" }],
          },
        ],
        volumes: [{ name: "scratch", emptyDir: { medium: "MEMORY", sizeLimit: "3Gi" } }],
        timeout: "3300s",
        serviceAccount: parsed.runtimeServiceAccount,
        executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
        nodeSelector: { accelerator: "nvidia-l4" },
        maxRetries: 0,
        gpuZonalRedundancyDisabled: true,
      },
    },
  };
}

export type ProviderMutation =
  | { readonly outcome: "accepted"; readonly operationRef: string }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "rejected"; readonly errorKind: "permanent" | "retryable" }
  | { readonly outcome: "unknown" };

export interface ProviderJob {
  readonly ref: string;
  readonly uid: string;
  readonly etag: string;
  readonly ready: boolean;
  readonly manifest: CloudRunJobManifest;
}

export type ProviderJobRead =
  | { readonly outcome: "found"; readonly job: ProviderJob }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "unavailable" };

export type ProviderExecutionStatus = "cancelled" | "failed" | "pending" | "running" | "succeeded";

export interface ProviderExecution {
  readonly ref: string;
  readonly uid: string;
  readonly etag: string;
  readonly jobRef: string;
  readonly status: ProviderExecutionStatus;
  readonly taskCount: 1;
  readonly parallelism: 1;
  readonly retriedCount: 0;
}

export const providerExecutionStatusSchema = z.enum([
  "cancelled",
  "failed",
  "pending",
  "running",
  "succeeded",
]);

export type ProviderExecutionList =
  | { readonly outcome: "found"; readonly executions: readonly ProviderExecution[] }
  | { readonly outcome: "unavailable" };

export type ProviderOperationRead =
  | { readonly outcome: "pending" | "succeeded" }
  | { readonly outcome: "failed"; readonly errorKind: "permanent" | "retryable" }
  | { readonly outcome: "unavailable" };

export interface CloudRunAdminPort {
  cancelExecution(execution: ProviderExecution): Promise<ProviderMutation>;
  createJob(jobId: string, manifest: CloudRunJobManifest): Promise<ProviderMutation>;
  deleteExecution(execution: ProviderExecution): Promise<ProviderMutation>;
  deleteJob(job: ProviderJob): Promise<ProviderMutation>;
  getJob(jobId: string): Promise<ProviderJobRead>;
  getOperation(operationRef: string): Promise<ProviderOperationRead>;
  listExecutions(jobId: string): Promise<ProviderExecutionList>;
  runJob(job: ProviderJob): Promise<ProviderMutation>;
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

export function manifestsMatch(left: CloudRunJobManifest, right: CloudRunJobManifest): boolean {
  return canonicalize(left) === canonicalize(right);
}

export async function deriveJobId(
  environment: ControllerEnvironment,
  executionHandle: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${environment}:${CONTROLLER_POLICY_ID}:${executionHandle}`),
    ),
  );
  const suffix = Array.from(digest.slice(0, 15), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `sd-${environment === "staging" ? "stg" : "prd"}-${suffix}`;
}
