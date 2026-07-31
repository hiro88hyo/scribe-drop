import { runpodPlacementStatusResponseSchema } from "@scribe-drop/contracts";
import { z } from "zod";

const RUNPOD_QUEUE_API_ORIGIN = "https://api.runpod.ai";
const RUNPOD_REST_API_ORIGIN = "https://rest.runpod.io";
const DEFAULT_TIMEOUT_MILLISECONDS = 15_000;
const MAX_RESPONSE_BYTES = 32 * 1024;

const resourceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const apiKeySchema = z.string().min(16).max(512);
const gpuTypeIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*[A-Za-z0-9]$/u);
const immutableWorkerImageSchema = z
  .string()
  .regex(
    /^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/scribe-drop-runpod-worker@sha256:[0-9a-f]{64}$/u,
  );

const runpodPodResponseSchema = z
  .object({
    desiredStatus: z.enum(["RUNNING", "EXITED", "TERMINATED"]),
    endpointId: resourceIdSchema.nullable(),
    id: resourceIdSchema,
    image: immutableWorkerImageSchema.optional(),
    imageName: immutableWorkerImageSchema.optional(),
    machine: z
      .object({
        gpuTypeId: gpuTypeIdSchema,
        secureCloud: z.boolean(),
      })
      .loose(),
  })
  .loose()
  .refine(
    ({ image, imageName }) =>
      (image !== undefined || imageName !== undefined) &&
      (image === undefined || imageName === undefined || image === imageName),
    { message: "RunPod Pod image identity is missing or contradictory" },
  )
  .transform(({ desiredStatus, endpointId, id, image, imageName, machine }) => ({
    desiredStatus,
    endpointId,
    id,
    image: image ?? imageName,
    machine: {
      gpuTypeId: machine.gpuTypeId,
      secureCloud: machine.secureCloud,
    },
  }));

export type RunpodPlacementVerificationResult =
  { readonly outcome: "verified" } | { readonly outcome: "rejected" | "unavailable" };

export interface RunpodPlacementVerifier {
  verify(runpodJobId: string): Promise<RunpodPlacementVerificationResult>;
}

export interface RunpodPlacementVerifierOptions {
  readonly allowedGpuTypeIds: readonly string[];
  readonly apiKey: string;
  readonly endpointId: string;
  readonly expectedImage: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)
  ) {
    return undefined;
  }
  if (response.body === null) {
    return undefined;
  }
  try {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let done = false;
    do {
      const result: unknown = await reader.read();
      if (!isRecord(result) || typeof result["done"] !== "boolean") {
        return undefined;
      }
      if (result["done"]) {
        done = true;
        continue;
      }
      const value = result["value"];
      if (!(value instanceof Uint8Array)) {
        return undefined;
      }
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    } while (!done);
    if (size === 0) {
      return undefined;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function fetchJson(
  fetchImplementation: typeof fetch,
  url: string,
  apiKey: string,
  timeoutMilliseconds: number,
): Promise<
  { readonly outcome: "found"; readonly value: unknown } | { readonly outcome: "unavailable" }
> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      headers: {
        accept: "application/json",
        "accept-encoding": "gzip",
        authorization: `Bearer ${apiKey}`,
      },
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch {
    return { outcome: "unavailable" };
  }
  if (!response.ok) {
    return { outcome: "unavailable" };
  }
  const value = await readBoundedJson(response);
  return value === undefined ? { outcome: "unavailable" } : { outcome: "found", value };
}

function workerIdFromStatus(value: unknown, expectedJobId: string): string | undefined {
  const parsed = runpodPlacementStatusResponseSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.id !== expectedJobId ||
    parsed.data.status !== "IN_PROGRESS" ||
    parsed.data.workerId === undefined
  ) {
    return undefined;
  }
  return resourceIdSchema.safeParse(parsed.data.workerId).data;
}

function placementMatches(
  value: unknown,
  workerId: string,
  endpointId: string,
  expectedImage: string,
  allowedGpuTypeIds: ReadonlySet<string>,
): boolean | undefined {
  const parsed = runpodPodResponseSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return (
    parsed.data.id === workerId &&
    parsed.data.endpointId === endpointId &&
    parsed.data.desiredStatus === "RUNNING" &&
    parsed.data.image === expectedImage &&
    parsed.data.machine.secureCloud &&
    allowedGpuTypeIds.has(parsed.data.machine.gpuTypeId)
  );
}

export function createRunpodPlacementVerifier(
  untrustedOptions: RunpodPlacementVerifierOptions,
): RunpodPlacementVerifier {
  const endpointId = resourceIdSchema.parse(untrustedOptions.endpointId);
  const expectedImage = immutableWorkerImageSchema.parse(untrustedOptions.expectedImage);
  const apiKey = apiKeySchema.parse(untrustedOptions.apiKey);
  const allowedGpuTypeIds = new Set(
    z.array(gpuTypeIdSchema).min(1).max(3).parse(untrustedOptions.allowedGpuTypeIds),
  );
  if (allowedGpuTypeIds.size !== untrustedOptions.allowedGpuTypeIds.length) {
    throw new Error("RunPod placement GPU type IDs must be unique");
  }
  const fetchImplementation = untrustedOptions.fetch ?? fetch;
  const timeoutMilliseconds = z
    .number()
    .int()
    .min(100)
    .max(30_000)
    .parse(untrustedOptions.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS);

  return {
    async verify(runpodJobId) {
      const parsedJobId = resourceIdSchema.safeParse(runpodJobId);
      if (!parsedJobId.success) {
        return { outcome: "rejected" };
      }
      const status = await fetchJson(
        fetchImplementation,
        `${RUNPOD_QUEUE_API_ORIGIN}/v2/${encodeURIComponent(endpointId)}/status/${encodeURIComponent(parsedJobId.data)}`,
        apiKey,
        timeoutMilliseconds,
      );
      if (status.outcome !== "found") {
        return status;
      }
      const parsedStatus = runpodPlacementStatusResponseSchema.safeParse(status.value);
      if (!parsedStatus.success) {
        return { outcome: "unavailable" };
      }
      const workerId = workerIdFromStatus(status.value, parsedJobId.data);
      if (workerId === undefined) {
        return { outcome: "rejected" };
      }
      const pod = await fetchJson(
        fetchImplementation,
        `${RUNPOD_REST_API_ORIGIN}/v1/pods/${encodeURIComponent(workerId)}?includeMachine=true&includeWorkers=true`,
        apiKey,
        timeoutMilliseconds,
      );
      if (pod.outcome !== "found") {
        return pod;
      }
      const matches = placementMatches(
        pod.value,
        workerId,
        endpointId,
        expectedImage,
        allowedGpuTypeIds,
      );
      return matches === undefined
        ? { outcome: "unavailable" }
        : matches
          ? { outcome: "verified" }
          : { outcome: "rejected" };
    },
  };
}
