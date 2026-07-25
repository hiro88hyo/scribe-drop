import { z } from "zod";

import {
  MAX_RECORDING_DURATION_SECONDS,
  SCHEMA_VERSION,
  transcriptionModelSchema,
  ulidSchema,
} from "./common.js";

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, "Expected a lowercase SHA-256");

export const manifestArtifactSchema = z
  .object({
    key: z.string().min(1).max(1024).startsWith("results/"),
    sha256: sha256Schema,
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

export const resultManifestSchema = z
  .object({
    artifacts: z
      .object({
        json: manifestArtifactSchema,
        markdown: manifestArtifactSchema,
        srt: manifestArtifactSchema,
      })
      .strict(),
    attemptId: ulidSchema,
    complete: z.literal(true),
    jobId: ulidSchema,
    schemaVersion: z.literal(SCHEMA_VERSION),
  })
  .strict();

export const transcriptSegmentSchema = z
  .object({
    end: z.number().nonnegative().max(MAX_RECORDING_DURATION_SECONDS),
    id: z.number().int().nonnegative(),
    start: z.number().nonnegative().max(MAX_RECORDING_DURATION_SECONDS),
    text: z.string(),
  })
  .strict()
  .refine(({ end, start }) => end >= start, "Segment end must not precede its start");

export const transcriptJsonSchema = z
  .object({
    attemptId: ulidSchema,
    durationSeconds: z.number().nonnegative().max(MAX_RECORDING_DURATION_SECONDS),
    jobId: ulidSchema,
    language: z.string().regex(/^[a-z]{2,3}$/u),
    languageProbability: z.number().min(0).max(1),
    model: transcriptionModelSchema,
    schemaVersion: z.literal(SCHEMA_VERSION),
    segments: z.array(transcriptSegmentSchema),
  })
  .strict();

export type ManifestArtifact = z.infer<typeof manifestArtifactSchema>;
export type ResultManifest = z.infer<typeof resultManifestSchema>;
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type TranscriptJson = z.infer<typeof transcriptJsonSchema>;
