import { z } from "zod";

import { MAX_FILE_SIZE_BYTES, ulidSchema, utcDateTimeSchema } from "./common.js";

export const normalizedR2ObjectCreatedEventSchema = z
  .object({
    bucket: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u),
    etag: z.string().min(1).max(512),
    eventType: z.literal("object-create"),
    jobId: ulidSchema,
    key: z.string().min(1).max(1024).startsWith("incoming/"),
    occurredAt: utcDateTimeSchema,
    sizeBytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
  })
  .strict()
  .refine(
    ({ jobId, key }) => key.split("/").at(2) === jobId,
    "Object key does not contain the declared job ID",
  );

export type NormalizedR2ObjectCreatedEvent = z.infer<typeof normalizedR2ObjectCreatedEventSchema>;
