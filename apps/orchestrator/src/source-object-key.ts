import { ulidSchema } from "@scribe-drop/contracts";
import { z } from "zod";

const sourceObjectKeySchema = z
  .string()
  .regex(
    /^incoming\/([0-9a-f]{32})\/([0-9A-HJKMNP-TV-Z]{26})\/([A-Za-z0-9_-]{22})\/source\.(?:flac|m4a|mov|mp3|mp4|ogg|opus|wav|webm)$/u,
  );

export interface ParsedSourceObjectKey {
  readonly jobId: string;
  readonly ownerHash: string;
}

export function parseSourceObjectKey(value: string): ParsedSourceObjectKey | undefined {
  const result = sourceObjectKeySchema.safeParse(value);
  if (!result.success) {
    return undefined;
  }
  const segments = result.data.split("/");
  const ownerHash = segments[1];
  const jobId = segments[2];
  if (
    ownerHash === undefined ||
    jobId === undefined ||
    !/^[0-9a-f]{32}$/u.test(ownerHash) ||
    !ulidSchema.safeParse(jobId).success
  ) {
    return undefined;
  }
  return { jobId, ownerHash };
}
