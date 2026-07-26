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
const secretValueSchema = z.string().min(16).max(512);

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
    runpodApiKey: secretValueSchema,
    runpodEndpointId: runpodEndpointIdSchema,
    runpodInternalBaseUrl: z.url(),
  })
  .strict()
  .refine(({ runpodInternalBaseUrl }) => isAllowedInternalBaseUrl(runpodInternalBaseUrl), {
    message: "RunPod internal base URL is not allowed for this environment",
    path: ["runpodInternalBaseUrl"],
  });

export interface OrchestratorConfigEnvironment {
  readonly APP_ENV: string;
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  readonly R2_BUCKET_NAME: string;
}

export interface RunpodConfigEnvironment extends OrchestratorConfigEnvironment {
  readonly R2_ACCESS_KEY_ID: string;
  readonly R2_SECRET_ACCESS_KEY: string;
  readonly RUNPOD_API_KEY: string;
  readonly RUNPOD_ENDPOINT_ID: string;
  readonly RUNPOD_INTERNAL_BASE_URL: string;
}

export interface OrchestratorConfig {
  readonly appEnvironment: DeploymentEnvironment;
  readonly cloudflareAccountId: string;
  readonly r2BucketName: string;
}

export interface RunpodConfig extends OrchestratorConfig {
  readonly r2AccessKeyId: string;
  readonly r2SecretAccessKey: string;
  readonly runpodApiKey: string;
  readonly runpodEndpointId: string;
  readonly runpodInternalBaseUrl: string;
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
    runpodApiKey: environment.RUNPOD_API_KEY,
    runpodEndpointId: environment.RUNPOD_ENDPOINT_ID,
    runpodInternalBaseUrl: environment.RUNPOD_INTERNAL_BASE_URL,
  });
  return result.success ? result.data : undefined;
}
