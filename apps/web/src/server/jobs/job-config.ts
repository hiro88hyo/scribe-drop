import { z } from "zod";

const r2BucketNameSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u);

export interface JobEnvironment {
  readonly R2_BUCKET_NAME: string;
}

export interface JobConfig {
  readonly r2BucketName: string;
}

export function parseJobConfig(environment: JobEnvironment): JobConfig | undefined {
  const result = r2BucketNameSchema.safeParse(environment.R2_BUCKET_NAME);
  return result.success ? { r2BucketName: result.data } : undefined;
}
