import {
  boundedResultManifestSchema,
  type BoundedResultManifest,
  type CloudRunTerminalRequest,
} from "@scribe-drop/contracts";

import {
  createD1CloudRunTerminalRepository,
  type CloudRunTerminalRepository,
} from "./cloud-run-terminal-repository.js";
import type { RuntimeAttemptContext } from "./cloud-run-runtime-store.js";

const MAX_MANIFEST_BYTES = 64 * 1024;

export interface CloudRunTerminalFinalizerPort {
  finalize(input: {
    readonly context: RuntimeAttemptContext;
    readonly request: CloudRunTerminalRequest;
  }): Promise<void>;
}

export interface CloudRunTerminalFinalizerDependencies {
  readonly createEventId: () => string;
  readonly createNotificationId: () => string;
  readonly createRepository?: (database: D1Database) => CloudRunTerminalRepository;
  readonly now: () => Date;
  readonly readManifest?: (bucket: R2Bucket, key: string) => Promise<unknown>;
  readonly readArtifactSize?: (bucket: R2Bucket, key: string) => Promise<number | null>;
}

async function readManifest(bucket: R2Bucket, key: string): Promise<unknown> {
  const object = await bucket.get(key);
  if (object === null || object.size <= 0 || object.size > MAX_MANIFEST_BYTES) return null;
  const text = await object.text();
  if (new TextEncoder().encode(text).byteLength > MAX_MANIFEST_BYTES) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function manifestMatchesContext(
  manifest: BoundedResultManifest,
  context: RuntimeAttemptContext,
  request: CloudRunTerminalRequest,
): boolean {
  return (
    manifest.attemptId === context.attemptId &&
    manifest.jobId === context.jobId &&
    manifest.artifacts.length === request.artifactCount &&
    manifest.requestedFormats.length === context.options.outputFormats.length &&
    manifest.requestedFormats.every(
      (format, index) => format === context.options.outputFormats[index],
    )
  );
}

export class CloudRunTerminalFinalizer implements CloudRunTerminalFinalizerPort {
  readonly #bucket: R2Bucket;
  readonly #database: D1Database;
  readonly #dependencies: CloudRunTerminalFinalizerDependencies;

  constructor(
    database: D1Database,
    bucket: R2Bucket,
    dependencies: CloudRunTerminalFinalizerDependencies,
  ) {
    this.#database = database;
    this.#bucket = bucket;
    this.#dependencies = dependencies;
  }

  async finalize(input: {
    readonly context: RuntimeAttemptContext;
    readonly request: CloudRunTerminalRequest;
  }): Promise<void> {
    const repositoryFactory =
      this.#dependencies.createRepository ?? createD1CloudRunTerminalRepository;
    const repository = repositoryFactory(this.#database);
    const common = {
      attemptId: input.context.attemptId,
      eventId: this.#dependencies.createEventId(),
      executionHandle: input.context.executionHandle,
      jobId: input.context.jobId,
      notificationId: this.#dependencies.createNotificationId(),
      request: input.request,
      timestamp: this.#dependencies.now().toISOString(),
    };
    if (input.request.status !== "succeeded") {
      if (!(await repository.finalizeFailure(common))) {
        throw new Error("Cloud Run terminal failure could not be finalized");
      }
      return;
    }
    const read = this.#dependencies.readManifest ?? readManifest;
    const untrusted = await read(
      this.#bucket,
      `results/${input.context.ownerHash}/${input.context.jobId}/${input.context.attemptId}/manifest.json`,
    );
    const parsed = boundedResultManifestSchema.safeParse(untrusted);
    if (!parsed.success || !manifestMatchesContext(parsed.data, input.context, input.request)) {
      throw new Error("Cloud Run result manifest was rejected");
    }
    const readSize =
      this.#dependencies.readArtifactSize ??
      (async (bucket: R2Bucket, key: string) => (await bucket.head(key))?.size ?? null);
    const sizes = await Promise.all(
      parsed.data.artifacts.map(({ key }) => readSize(this.#bucket, key)),
    );
    if (sizes.some((size, index) => size !== parsed.data.artifacts[index]?.sizeBytes)) {
      throw new Error("Cloud Run result artifact was rejected");
    }
    if (!(await repository.finalizeSuccess({ ...common, manifest: parsed.data }))) {
      throw new Error("Cloud Run terminal success could not be finalized");
    }
  }
}
