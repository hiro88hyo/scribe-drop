import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MAX_FILE_SIZE_BYTES, httpsUrlSchema } from "@scribe-drop/contracts";
import { R2_CAPABILITY_TTL_SECONDS } from "@scribe-drop/domain";
import { z } from "zod";

export { R2_CAPABILITY_TTL_SECONDS } from "@scribe-drop/domain";

const r2CapabilityRequestSchema = z
  .object({
    resultPrefix: z.string().min(1).max(900).startsWith("results/").endsWith("/"),
    sourceBucket: z.string().min(3).max(63),
    sourceKey: z.string().min(1).max(1024).startsWith("incoming/"),
  })
  .strict();

export interface R2CapabilityUrls {
  readonly expiresAt: string;
  readonly jsonPutUrl: string;
  readonly manifestPutUrl: string;
  readonly markdownPutUrl: string;
  readonly sourceGetUrl: string;
  readonly srtPutUrl: string;
}

export interface R2CapabilityIssuer {
  issue(request: {
    readonly resultPrefix: string;
    readonly sourceBucket: string;
    readonly sourceKey: string;
  }): Promise<R2CapabilityUrls>;
}

type R2Command = GetObjectCommand | PutObjectCommand;
type R2CommandSigner = (
  command: R2Command,
  expiresInSeconds: number,
  signingDate: Date,
) => Promise<string>;

export interface R2CapabilityIssuerOptions {
  readonly accessKeyId: string;
  readonly accountId: string;
  readonly now?: () => Date;
  readonly secretAccessKey: string;
  readonly sign?: R2CommandSigner;
}

export function createR2CapabilityIssuer(options: R2CapabilityIssuerOptions): R2CapabilityIssuer {
  const client = new S3Client({
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    endpoint: `https://${options.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    region: "auto",
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const sign: R2CommandSigner =
    options.sign ??
    ((command, expiresInSeconds, signingDate) =>
      getSignedUrl(client, command, {
        expiresIn: expiresInSeconds,
        signingDate,
      }));
  const now = options.now ?? (() => new Date());

  return {
    async issue(untrustedRequest) {
      const request = r2CapabilityRequestSchema.parse(untrustedRequest);
      const signingDate = now();
      const resultKey = (filename: string): string => `${request.resultPrefix}${filename}`;
      const commands = {
        jsonPutUrl: new PutObjectCommand({
          Bucket: request.sourceBucket,
          CacheControl: "no-store",
          Key: resultKey("transcript.json"),
        }),
        manifestPutUrl: new PutObjectCommand({
          Bucket: request.sourceBucket,
          CacheControl: "no-store",
          Key: resultKey("manifest.json"),
        }),
        markdownPutUrl: new PutObjectCommand({
          Bucket: request.sourceBucket,
          CacheControl: "no-store",
          Key: resultKey("transcript.md"),
        }),
        sourceGetUrl: new GetObjectCommand({
          Bucket: request.sourceBucket,
          Key: request.sourceKey,
        }),
        srtPutUrl: new PutObjectCommand({
          Bucket: request.sourceBucket,
          CacheControl: "no-store",
          Key: resultKey("transcript.srt"),
        }),
      };
      const [sourceGetUrl, markdownPutUrl, jsonPutUrl, srtPutUrl, manifestPutUrl] =
        await Promise.all([
          sign(commands.sourceGetUrl, R2_CAPABILITY_TTL_SECONDS, signingDate),
          sign(commands.markdownPutUrl, R2_CAPABILITY_TTL_SECONDS, signingDate),
          sign(commands.jsonPutUrl, R2_CAPABILITY_TTL_SECONDS, signingDate),
          sign(commands.srtPutUrl, R2_CAPABILITY_TTL_SECONDS, signingDate),
          sign(commands.manifestPutUrl, R2_CAPABILITY_TTL_SECONDS, signingDate),
        ]);
      return {
        expiresAt: new Date(
          signingDate.getTime() + R2_CAPABILITY_TTL_SECONDS * 1_000,
        ).toISOString(),
        jsonPutUrl: httpsUrlSchema.parse(jsonPutUrl),
        manifestPutUrl: httpsUrlSchema.parse(manifestPutUrl),
        markdownPutUrl: httpsUrlSchema.parse(markdownPutUrl),
        sourceGetUrl: httpsUrlSchema.parse(sourceGetUrl),
        srtPutUrl: httpsUrlSchema.parse(srtPutUrl),
      };
    },
  };
}

export const r2ClaimSourceMetadataSchema = z
  .object({
    expectedEtag: z.string().min(1).max(512),
    expectedSizeBytes: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
  })
  .strict();
