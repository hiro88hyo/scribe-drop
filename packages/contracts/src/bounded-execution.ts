import { z } from "zod";

import {
  OUTPUT_FORMATS,
  httpsUrlSchema,
  outputFormatSchema,
  transcriptionLanguageSchema,
  transcriptionModelSchema,
  ulidSchema,
} from "./common.js";
import { sha256Schema } from "./manifest.js";

export const BOUNDED_EXECUTION_CONTRACT_VERSION = 2;
export const BOUNDED_RESULT_MANIFEST_SCHEMA_VERSION = 3;
export const MAX_BOUNDED_ARTIFACT_BYTES = 128 * 1024 * 1024;

export const BOUNDED_ARTIFACT_FILENAMES = {
  json: "transcript.json",
  markdown: "transcript.md",
  srt: "transcript.srt",
} as const;

const canonicalOutputFormatsSchema = z
  .array(outputFormatSchema)
  .min(1)
  .max(OUTPUT_FORMATS.length)
  .refine((formats) => new Set(formats).size === formats.length, "Duplicate output format")
  .refine((formats) => {
    const canonical = OUTPUT_FORMATS.filter((format) => formats.includes(format));
    return formats.every((format, index) => format === canonical[index]);
  }, "Output formats must use canonical order");

export const boundedExecutionOptionsSchema = z
  .object({
    contractVersion: z.literal(BOUNDED_EXECUTION_CONTRACT_VERSION),
    language: transcriptionLanguageSchema,
    model: transcriptionModelSchema,
    outputFormats: canonicalOutputFormatsSchema,
    vad: z.boolean(),
  })
  .strict();

export const boundedArtifactCapabilitySchema = z
  .object({
    format: outputFormatSchema,
    putUrl: httpsUrlSchema,
  })
  .strict();

export const boundedResultCapabilitiesSchema = z
  .object({
    artifacts: z.array(boundedArtifactCapabilitySchema).min(1).max(OUTPUT_FORMATS.length),
    manifestPutUrl: httpsUrlSchema,
  })
  .strict()
  .refine(
    ({ artifacts }) =>
      canonicalOutputFormatsSchema.safeParse(artifacts.map(({ format }) => format)).success,
    "Artifact capabilities must use canonical unique formats",
  );

export const boundedResultObjectKeySchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(
    /^results\/[0-9a-f]{32}\/[0-9A-HJKMNP-TV-Z]{26}\/[0-9A-HJKMNP-TV-Z]{26}\/transcript\.(?:md|json|srt)$/u,
  );

export const boundedManifestArtifactSchema = z
  .object({
    format: outputFormatSchema,
    key: boundedResultObjectKeySchema,
    sha256: sha256Schema,
    sizeBytes: z.number().int().nonnegative().max(MAX_BOUNDED_ARTIFACT_BYTES),
  })
  .strict();

export const boundedResultManifestSchema = z
  .object({
    artifacts: z.array(boundedManifestArtifactSchema).min(1).max(OUTPUT_FORMATS.length),
    attemptId: ulidSchema,
    complete: z.literal(true),
    detectedLanguage: z.string().regex(/^[a-z]{2,3}$/u),
    executionContractVersion: z.literal(BOUNDED_EXECUTION_CONTRACT_VERSION),
    jobId: ulidSchema,
    requestedLanguage: transcriptionLanguageSchema,
    requestedFormats: canonicalOutputFormatsSchema,
    schemaVersion: z.literal(BOUNDED_RESULT_MANIFEST_SCHEMA_VERSION),
  })
  .strict()
  .refine(
    ({ artifacts, requestedFormats }) =>
      artifacts.length === requestedFormats.length &&
      artifacts.every(({ format }, index) => format === requestedFormats[index]),
    "Manifest artifacts must exactly match requested formats",
  )
  .refine(
    ({ artifacts, attemptId, jobId }) =>
      artifacts.every(({ format, key }) =>
        key.endsWith(`/${jobId}/${attemptId}/${BOUNDED_ARTIFACT_FILENAMES[format]}`),
      ),
    "Manifest artifact key must match its attempt and format",
  )
  .refine(
    ({ detectedLanguage, requestedLanguage }) =>
      requestedLanguage === "auto" || detectedLanguage === requestedLanguage,
    "Manifest detected language must match a fixed requested language",
  );

export type BoundedExecutionOptions = z.infer<typeof boundedExecutionOptionsSchema>;
export type BoundedResultCapabilities = z.infer<typeof boundedResultCapabilitiesSchema>;
export type BoundedResultManifest = z.infer<typeof boundedResultManifestSchema>;
