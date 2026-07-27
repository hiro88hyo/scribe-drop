import { z } from "zod";

const R2_DELETE_BATCH_SIZE = 1_000;
const MAX_R2_DELETE_BATCHES = 10_000;

const objectKeySchema = z.string().min(1).max(1_024);
const objectPrefixSchema = z.string().min(1).max(900).endsWith("/");
const r2ListResultSchema = z
  .object({
    objects: z.array(
      z.looseObject({
        key: objectKeySchema,
      }),
    ),
    truncated: z.boolean(),
  })
  .loose();

export class R2CleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "R2CleanupError";
  }
}

export async function deleteR2Object(bucket: R2Bucket, untrustedKey: string): Promise<void> {
  const key = objectKeySchema.parse(untrustedKey);
  try {
    await bucket.delete(key);
  } catch {
    throw new R2CleanupError("R2 object deletion failed");
  }
}

export async function assertR2ObjectAbsent(bucket: R2Bucket, untrustedKey: string): Promise<void> {
  const key = objectKeySchema.parse(untrustedKey);
  let object: unknown;
  try {
    object = await bucket.head(key);
  } catch {
    throw new R2CleanupError("R2 deletion verification failed");
  }
  if (object !== null) {
    throw new R2CleanupError("R2 object remained after deletion");
  }
}

export async function deleteR2ObjectAndVerify(bucket: R2Bucket, key: string): Promise<void> {
  await deleteR2Object(bucket, key);
  await assertR2ObjectAbsent(bucket, key);
}

export async function deleteR2Prefix(bucket: R2Bucket, untrustedPrefix: string): Promise<void> {
  const prefix = objectPrefixSchema.parse(untrustedPrefix);
  for (let batchIndex = 0; batchIndex < MAX_R2_DELETE_BATCHES; batchIndex += 1) {
    let untrustedPage: unknown;
    try {
      untrustedPage = await bucket.list({
        limit: R2_DELETE_BATCH_SIZE,
        prefix,
      });
    } catch {
      throw new R2CleanupError("R2 object listing failed");
    }
    const page = r2ListResultSchema.parse(untrustedPage);
    const keys = page.objects.map((object) => object.key);
    if (keys.some((key) => !key.startsWith(prefix))) {
      throw new Error("R2 returned an object outside the deletion prefix");
    }
    if (keys.length === 0) {
      if (page.truncated) {
        throw new Error("R2 returned an empty truncated deletion page");
      }
      return;
    }
    try {
      await bucket.delete(keys);
    } catch {
      throw new R2CleanupError("R2 prefix deletion failed");
    }
  }
  throw new Error("R2 prefix deletion exceeded the safety limit");
}
