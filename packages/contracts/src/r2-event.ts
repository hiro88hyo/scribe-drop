import { z } from "zod";

import { MAX_FILE_SIZE_BYTES, ulidSchema, utcDateTimeSchema } from "./common.js";

const MAX_R2_OBJECT_SIZE_BYTES = 5 * 1024 * 1024 * 1024 * 1024;
const r2BucketNameSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u);

export const r2EventNotificationSchema = z
  .object({
    account: z.string().regex(/^[0-9a-f]{32}$/u),
    action: z.enum(["CompleteMultipartUpload", "CopyObject", "PutObject"]),
    bucket: r2BucketNameSchema,
    copySource: z
      .object({
        bucket: r2BucketNameSchema,
        object: z.string().min(1).max(1024),
      })
      .strict()
      .optional(),
    eventTime: utcDateTimeSchema,
    object: z
      .object({
        eTag: z.string().min(1).max(512),
        key: z.string().min(1).max(1024),
        size: z.number().int().nonnegative().max(MAX_R2_OBJECT_SIZE_BYTES),
      })
      .strict(),
  })
  .strict()
  .superRefine((event, context) => {
    const hasCopySource = event.copySource !== undefined;
    if ((event.action === "CopyObject") !== hasCopySource) {
      context.addIssue({
        code: "custom",
        message: "copySource must be present only for CopyObject",
        path: ["copySource"],
      });
    }
  });

export const normalizedR2ObjectCreatedEventSchema = z
  .object({
    bucket: r2BucketNameSchema,
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

export type R2EventNotification = z.infer<typeof r2EventNotificationSchema>;
export type NormalizedR2ObjectCreatedEvent = z.infer<typeof normalizedR2ObjectCreatedEventSchema>;
