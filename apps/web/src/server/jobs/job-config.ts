import { z } from "zod";

const cloudflareAccountIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
const r2BucketNameSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u);
const secretSchema = z.string().max(4096).refine(
  (value) => {
    const byteLength = new TextEncoder().encode(value).byteLength;
    return byteLength >= 32 && byteLength <= 4096;
  },
  "Secret must contain between 32 and 4096 bytes",
);
const accessKeyIdSchema = z.string().min(1).max(256);

export interface JobEnvironment {
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  readonly OWNER_HASH_HMAC_SECRET: string;
  readonly R2_PARENT_ACCESS_KEY_ID: string;
  readonly R2_PARENT_SECRET_ACCESS_KEY: string;
  readonly R2_BUCKET_NAME: string;
}

export interface JobConfig {
  readonly cloudflareAccountId: string;
  readonly ownerHashHmacSecret: string;
  readonly r2ParentAccessKeyId: string;
  readonly r2ParentSecretAccessKey: string;
  readonly r2BucketName: string;
}

export function parseJobConfig(environment: JobEnvironment): JobConfig | undefined {
  const result = z
    .object({
      cloudflareAccountId: cloudflareAccountIdSchema,
      ownerHashHmacSecret: secretSchema,
      r2BucketName: r2BucketNameSchema,
      r2ParentAccessKeyId: accessKeyIdSchema,
      r2ParentSecretAccessKey: secretSchema,
    })
    .strict()
    .safeParse({
      cloudflareAccountId: environment.CLOUDFLARE_ACCOUNT_ID,
      ownerHashHmacSecret: environment.OWNER_HASH_HMAC_SECRET,
      r2BucketName: environment.R2_BUCKET_NAME,
      r2ParentAccessKeyId: environment.R2_PARENT_ACCESS_KEY_ID,
      r2ParentSecretAccessKey: environment.R2_PARENT_SECRET_ACCESS_KEY,
    });
  return result.success ? result.data : undefined;
}
