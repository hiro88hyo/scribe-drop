import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  artifactDownloadResponseSchema,
  httpsUrlSchema,
  type ArtifactDownloadResponse,
} from "@scribe-drop/contracts";
import { z } from "zod";

export const ARTIFACT_DOWNLOAD_TTL_SECONDS = 5 * 60;

const inputSchema = z
  .object({
    accountId: z.string().regex(/^[0-9a-f]{32}$/u),
    bucket: z.string().min(3).max(63),
    key: z.string().min(1).max(1024).startsWith("results/"),
    parentAccessKeyId: z.string().min(1).max(256),
    parentSecretAccessKey: z.string().min(32).max(4096),
  })
  .strict();

export interface ArtifactDownloadInput {
  readonly accountId: string;
  readonly bucket: string;
  readonly key: string;
  readonly now: Date;
  readonly parentAccessKeyId: string;
  readonly parentSecretAccessKey: string;
}

export async function createArtifactDownload(
  untrustedInput: ArtifactDownloadInput,
): Promise<ArtifactDownloadResponse> {
  const input = inputSchema.parse({
    accountId: untrustedInput.accountId,
    bucket: untrustedInput.bucket,
    key: untrustedInput.key,
    parentAccessKeyId: untrustedInput.parentAccessKeyId,
    parentSecretAccessKey: untrustedInput.parentSecretAccessKey,
  });
  const client = new S3Client({
    credentials: {
      accessKeyId: input.parentAccessKeyId,
      secretAccessKey: input.parentSecretAccessKey,
    },
    endpoint: `https://${input.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    region: "auto",
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const url = await getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      ResponseContentDisposition: "attachment",
    }),
    {
      expiresIn: ARTIFACT_DOWNLOAD_TTL_SECONDS,
      signingDate: untrustedInput.now,
    },
  );
  return artifactDownloadResponseSchema.parse({
    expiresAt: new Date(
      untrustedInput.now.getTime() + ARTIFACT_DOWNLOAD_TTL_SECONDS * 1_000,
    ).toISOString(),
    url: httpsUrlSchema.parse(url),
  });
}
