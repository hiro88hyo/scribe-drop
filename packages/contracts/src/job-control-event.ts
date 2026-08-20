import { z } from "zod";

import { ulidSchema, utcDateTimeSchema } from "./common.js";

export const jobControlEventSchema = z
  .object({
    action: z.literal("cancel"),
    eventId: ulidSchema,
    jobId: ulidSchema,
    requestedAt: utcDateTimeSchema,
    schemaVersion: z.literal(1),
    type: z.literal("job-control"),
  })
  .strict();

export type JobControlEvent = z.infer<typeof jobControlEventSchema>;
