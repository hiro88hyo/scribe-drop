import { ulidSchema, utcDateTimeSchema } from "@scribe-drop/contracts";
import { z } from "zod";

import { decodeBase64Url, encodeBase64Url } from "../security/base64url.js";

const cursorPayloadSchema = z
  .object({
    createdAt: utcDateTimeSchema,
    id: ulidSchema,
  })
  .strict();

export type JobCursor = z.infer<typeof cursorPayloadSchema>;

export function encodeJobCursor(cursor: JobCursor): string {
  const payload = cursorPayloadSchema.parse(cursor);
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

export function decodeJobCursor(value: string): JobCursor | undefined {
  const decoded = decodeBase64Url(value);
  if (decoded === undefined) {
    return undefined;
  }

  try {
    const untrusted: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(decoded),
    );
    const result = cursorPayloadSchema.safeParse(untrusted);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
