import { BOUNDED_ARTIFACT_FILENAMES } from "@scribe-drop/contracts";

import type { RuntimeCapabilityIssuer } from "./cloud-run-runtime-service.js";
import type { RuntimeClaimCapabilities } from "./cloud-run-runtime-store.js";
import type { R2CapabilityIssuer } from "./r2-capability-issuer.js";

export class R2RuntimeCapabilityIssuer implements RuntimeCapabilityIssuer {
  readonly #bucket: string;
  readonly #issuer: R2CapabilityIssuer;

  constructor(bucket: string, issuer: R2CapabilityIssuer) {
    this.#bucket = bucket;
    this.#issuer = issuer;
  }

  async issue(
    input: Parameters<RuntimeCapabilityIssuer["issue"]>[0],
  ): Promise<RuntimeClaimCapabilities> {
    const resultPrefix = `results/${input.context.ownerHash}/${input.context.jobId}/${input.context.attemptId}/`;
    const capabilities = await this.#issuer.issue({
      resultPrefix,
      sourceBucket: this.#bucket,
      sourceKey: input.context.sourceKey,
    });
    if (Date.parse(capabilities.expiresAt) < Date.parse(input.expiresAt)) {
      throw new Error("R2 capability expires before the runtime session");
    }
    const urls = {
      json: capabilities.jsonPutUrl,
      markdown: capabilities.markdownPutUrl,
      srt: capabilities.srtPutUrl,
    } as const;
    return {
      results: {
        artifacts: input.context.options.outputFormats.map((format) => ({
          format,
          key: `${resultPrefix}${BOUNDED_ARTIFACT_FILENAMES[format]}`,
          putUrl: urls[format],
        })),
        manifestPutUrl: capabilities.manifestPutUrl,
      },
      source: {
        expectedEtag: input.context.sourceEtag,
        expectedSizeBytes: input.context.sourceSizeBytes,
        getUrl: capabilities.sourceGetUrl,
      },
    };
  }
}
