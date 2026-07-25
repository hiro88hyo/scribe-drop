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

export interface OrchestratorConfigEnvironment {
  readonly APP_ENV: string;
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  readonly R2_BUCKET_NAME: string;
}

export interface OrchestratorConfig {
  readonly appEnvironment: DeploymentEnvironment;
  readonly cloudflareAccountId: string;
  readonly r2BucketName: string;
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
