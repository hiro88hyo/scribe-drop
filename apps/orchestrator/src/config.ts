import { DEPLOYMENT_ENVIRONMENTS, type DeploymentEnvironment } from "@scribe-drop/observability";
import { z } from "zod";

const orchestratorConfigSchema = z
  .object({
    appEnvironment: z.enum(DEPLOYMENT_ENVIRONMENTS),
    cloudflareAccountId: z.string().regex(/^[0-9a-f]{32}$/u),
    r2BucketName: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u),
  })
  .strict();

const runpodEndpointIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const runpodGpuTypeIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*[A-Za-z0-9]$/u);
const runpodGpuTypeIdsSchema = z
  .string()
  .transform((value) => value.split(",").map((candidate) => candidate.trim()))
  .pipe(z.array(runpodGpuTypeIdSchema).min(1).max(3))
  .refine((values) => new Set(values).size === values.length, {
    message: "RunPod GPU type IDs must be unique",
  });
const runpodWorkerImageSchema = z
  .string()
  .regex(
    /^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/scribe-drop-runpod-worker@sha256:[0-9a-f]{64}$/u,
  );
const secretValueSchema = z.string().min(16).max(512);
const retentionIntegerSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/u)
  .transform(Number)
  .pipe(z.number().int().positive().max(3_650));

function isAllowedInternalBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    hostname !== "localhost" &&
    hostname !== "metadata.google.internal" &&
    !hostname.endsWith(".local") &&
    !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname) &&
    !hostname.startsWith("[")
  );
}

const runpodConfigSchema = orchestratorConfigSchema
  .extend({
    r2AccessKeyId: secretValueSchema,
    r2SecretAccessKey: secretValueSchema,
    runpodAllowedGpuTypeIds: runpodGpuTypeIdsSchema,
    runpodApiKey: secretValueSchema,
    runpodEndpointId: runpodEndpointIdSchema,
    runpodInternalBaseUrl: z.url(),
    runpodWorkerImage: runpodWorkerImageSchema,
  })
  .strict()
  .refine(({ runpodInternalBaseUrl }) => isAllowedInternalBaseUrl(runpodInternalBaseUrl), {
    message: "RunPod internal base URL is not allowed for this environment",
    path: ["runpodInternalBaseUrl"],
  });

const notificationConfigSchema = z
  .object({
    discordWebhookUrl: z.url().max(2048),
    webBaseUrl: z.url().max(2048),
  })
  .strict()
  .refine(
    ({ discordWebhookUrl }) => {
      const url = new URL(discordWebhookUrl);
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.port === "" &&
        url.search === "" &&
        url.hash === "" &&
        ["discord.com", "canary.discord.com", "ptb.discord.com"].includes(
          url.hostname.toLowerCase(),
        ) &&
        /^\/api\/webhooks\/[0-9]+\/[A-Za-z0-9._-]+$/u.test(url.pathname)
      );
    },
    {
      message: "Discord webhook URL is not allowed",
      path: ["discordWebhookUrl"],
    },
  );

const retentionConfigSchema = z
  .object({
    auditRetentionDays: retentionIntegerSchema,
    multipartRetentionHours: retentionIntegerSchema.refine((value) => value <= 24 * 30),
    resultRetentionDays: retentionIntegerSchema,
    sourceRetentionDays: retentionIntegerSchema,
  })
  .strict()
  .refine(
    ({ auditRetentionDays, resultRetentionDays, sourceRetentionDays }) =>
      sourceRetentionDays <= resultRetentionDays && resultRetentionDays <= auditRetentionDays,
    {
      message: "Retention must satisfy source <= result <= audit",
    },
  );

function isAllowedWebBaseUrl(value: string, environment: DeploymentEnvironment): boolean {
  if (environment !== "local") {
    return isAllowedInternalBaseUrl(value);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname.toLowerCase() === "localhost" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    (url.pathname === "" || url.pathname === "/")
  );
}

export interface OrchestratorConfigEnvironment {
  readonly APP_ENV: string;
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  readonly R2_BUCKET_NAME: string;
}

export interface RunpodConfigEnvironment extends OrchestratorConfigEnvironment {
  readonly R2_ACCESS_KEY_ID: string;
  readonly R2_SECRET_ACCESS_KEY: string;
  readonly RUNPOD_ALLOWED_GPU_IDS: string;
  readonly RUNPOD_API_KEY: string;
  readonly RUNPOD_ENDPOINT_ID: string;
  readonly RUNPOD_INTERNAL_BASE_URL: string;
  readonly RUNPOD_WORKER_IMAGE: string;
}

export interface NotificationConfigEnvironment {
  readonly APP_ENV: string;
  readonly DISCORD_WEBHOOK_URL?: string;
  readonly WEB_BASE_URL?: string;
}

export interface RetentionConfigEnvironment {
  readonly AUDIT_RETENTION_DAYS: string;
  readonly MULTIPART_RETENTION_HOURS: string;
  readonly RESULT_RETENTION_DAYS: string;
  readonly SOURCE_RETENTION_DAYS: string;
}

export interface OrchestratorConfig {
  readonly appEnvironment: DeploymentEnvironment;
  readonly cloudflareAccountId: string;
  readonly r2BucketName: string;
}

export interface RunpodConfig extends OrchestratorConfig {
  readonly r2AccessKeyId: string;
  readonly r2SecretAccessKey: string;
  readonly runpodAllowedGpuTypeIds: readonly string[];
  readonly runpodApiKey: string;
  readonly runpodEndpointId: string;
  readonly runpodInternalBaseUrl: string;
  readonly runpodWorkerImage: string;
}

export interface NotificationConfig {
  readonly discordWebhookUrl: string;
  readonly webBaseUrl: string;
}

export interface RetentionConfig {
  readonly auditRetentionDays: number;
  readonly multipartRetentionHours: number;
  readonly resultRetentionDays: number;
  readonly sourceRetentionDays: number;
}

export function parseOrchestratorConfig(
  environment: OrchestratorConfigEnvironment,
): OrchestratorConfig | undefined {
  const result = orchestratorConfigSchema.safeParse({
    appEnvironment: environment.APP_ENV,
    cloudflareAccountId: environment.CLOUDFLARE_ACCOUNT_ID,
    r2BucketName: environment.R2_BUCKET_NAME,
  });
  return result.success ? result.data : undefined;
}

export function parseRunpodConfig(environment: RunpodConfigEnvironment): RunpodConfig | undefined {
  const result = runpodConfigSchema.safeParse({
    appEnvironment: environment.APP_ENV,
    cloudflareAccountId: environment.CLOUDFLARE_ACCOUNT_ID,
    r2AccessKeyId: environment.R2_ACCESS_KEY_ID,
    r2BucketName: environment.R2_BUCKET_NAME,
    r2SecretAccessKey: environment.R2_SECRET_ACCESS_KEY,
    runpodAllowedGpuTypeIds: environment.RUNPOD_ALLOWED_GPU_IDS,
    runpodApiKey: environment.RUNPOD_API_KEY,
    runpodEndpointId: environment.RUNPOD_ENDPOINT_ID,
    runpodInternalBaseUrl: environment.RUNPOD_INTERNAL_BASE_URL,
    runpodWorkerImage: environment.RUNPOD_WORKER_IMAGE,
  });
  return result.success ? result.data : undefined;
}

export function parseNotificationConfig(
  environment: NotificationConfigEnvironment,
): NotificationConfig | undefined {
  const environmentResult = z.enum(DEPLOYMENT_ENVIRONMENTS).safeParse(environment.APP_ENV);
  const result = notificationConfigSchema.safeParse({
    discordWebhookUrl: environment.DISCORD_WEBHOOK_URL,
    webBaseUrl: environment.WEB_BASE_URL,
  });
  return result.success &&
    environmentResult.success &&
    isAllowedWebBaseUrl(result.data.webBaseUrl, environmentResult.data)
    ? result.data
    : undefined;
}

export function parseRetentionConfig(
  environment: RetentionConfigEnvironment,
): RetentionConfig | undefined {
  const result = retentionConfigSchema.safeParse({
    auditRetentionDays: environment.AUDIT_RETENTION_DAYS,
    multipartRetentionHours: environment.MULTIPART_RETENTION_HOURS,
    resultRetentionDays: environment.RESULT_RETENTION_DAYS,
    sourceRetentionDays: environment.SOURCE_RETENTION_DAYS,
  });
  return result.success ? result.data : undefined;
}
