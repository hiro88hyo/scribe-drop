import { z } from "zod";

import type {
  CloudRunAdminPort,
  CloudRunJobManifest,
  ProviderExecution,
  ProviderExecutionList,
  ProviderJob,
  ProviderJobRead,
  ProviderMutation,
  ProviderOperationRead,
} from "./provider.js";

const MAX_PROVIDER_RESPONSE_BYTES = 65_536;
const PROVIDER_TIMEOUT_MS = 10_000;

const binaryAuthorizationSchema = z
  .object({
    breakglassJustification: z.literal("").optional(),
    policy: z.never().optional(),
    useDefault: z.literal(true),
  })
  .strict();

export const cloudRunJobManifestSchema = z
  .object({
    binaryAuthorization: binaryAuthorizationSchema,
    labels: z.record(z.string(), z.string()),
    template: z
      .object({
        taskCount: z.literal(1),
        parallelism: z.literal(1),
        template: z
          .object({
            containers: z.tuple([
              z
                .object({
                  name: z.literal("worker"),
                  image: z.string(),
                  command: z.tuple([
                    z.literal("python"),
                    z.literal("-m"),
                    z.literal("scribe_drop_worker.one_shot"),
                  ]),
                  env: z.tuple([
                    z
                      .object({
                        name: z.literal("APP_ENV"),
                        value: z.enum(["staging", "production"]),
                      })
                      .strict(),
                    z
                      .object({
                        name: z.literal("SCRIBE_DROP_BOOTSTRAP_REQUEST_ID"),
                        value: z.string(),
                      })
                      .strict(),
                    z
                      .object({
                        name: z.literal("SCRIBE_DROP_EXECUTION_HANDLE"),
                        value: z.string(),
                      })
                      .strict(),
                    z
                      .object({
                        name: z.literal("SCRIBE_DROP_EXECUTION_POLICY"),
                        value: z.literal("cloud_run_jobs_l4_v1"),
                      })
                      .strict(),
                    z
                      .object({
                        name: z.literal("SCRIBE_DROP_ORCHESTRATOR_ORIGIN"),
                        value: z.string(),
                      })
                      .strict(),
                    z
                      .object({
                        name: z.literal("SCRIBE_DROP_IDENTITY_AUDIENCE"),
                        value: z.string(),
                      })
                      .strict(),
                    z
                      .object({
                        name: z.literal("SCRIBE_DROP_SOURCE_HOST"),
                        value: z.string(),
                      })
                      .strict(),
                    z
                      .object({
                        name: z.literal("SCRIBE_DROP_RESULT_HOST"),
                        value: z.string(),
                      })
                      .strict(),
                  ]),
                  resources: z
                    .object({
                      limits: z
                        .object({
                          cpu: z.literal("4"),
                          memory: z.literal("16Gi"),
                          "nvidia.com/gpu": z.literal("1"),
                        })
                        .strict(),
                    })
                    .strict(),
                  volumeMounts: z.tuple([
                    z.object({ name: z.literal("scratch"), mountPath: z.literal("/tmp") }).strict(),
                  ]),
                })
                .strict(),
            ]),
            volumes: z.tuple([
              z
                .object({
                  name: z.literal("scratch"),
                  emptyDir: z
                    .object({ medium: z.literal("MEMORY"), sizeLimit: z.literal("3Gi") })
                    .strict(),
                })
                .strict(),
            ]),
            timeout: z.literal("3300s"),
            serviceAccount: z.string(),
            executionEnvironment: z.literal("EXECUTION_ENVIRONMENT_GEN2"),
            nodeSelector: z.object({ accelerator: z.literal("nvidia-l4") }).strict(),
            maxRetries: z.literal(0),
            gpuZonalRedundancyDisabled: z.literal(true),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const operationSchema = z
  .object({
    name: z.string().min(1),
    done: z.boolean().optional(),
    error: z
      .object({
        code: z.number().int(),
      })
      .loose()
      .optional(),
  })
  .loose();
const jobSchema = z
  .object({
    name: z.string().min(1),
    uid: z.uuid(),
    etag: z.string().min(1),
    reconciling: z.boolean().optional(),
    terminalCondition: z
      .object({
        state: z.enum([
          "CONDITION_PENDING",
          "CONDITION_RECONCILING",
          "CONDITION_SUCCEEDED",
          "CONDITION_FAILED",
        ]),
      })
      .loose()
      .optional(),
    binaryAuthorization: binaryAuthorizationSchema,
    labels: z.record(z.string(), z.string()),
    template: cloudRunJobManifestSchema.shape.template,
  })
  .loose();

const executionSchema = z
  .object({
    name: z.string().min(1),
    uid: z.uuid(),
    etag: z.string().min(1),
    job: z.string().min(1),
    taskCount: z.literal(1),
    parallelism: z.literal(1),
    retriedCount: z.literal(0).optional(),
    runningCount: z.number().int().nonnegative().optional(),
    succeededCount: z.number().int().nonnegative().optional(),
    failedCount: z.number().int().nonnegative().optional(),
    cancelledCount: z.number().int().nonnegative().optional(),
    reconciling: z.boolean().optional(),
  })
  .loose();

const executionListSchema = z
  .object({
    executions: z.array(executionSchema).max(2).optional(),
    nextPageToken: z.string().min(1).optional(),
  })
  .loose();

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export interface CloudRunClientConfiguration {
  readonly projectId: string;
  readonly region: "asia-southeast1";
}

interface ProviderHttpResponse {
  readonly status: number;
  readonly value: unknown;
}

export class CloudRunJobsClient implements CloudRunAdminPort {
  readonly #configuration: CloudRunClientConfiguration;
  readonly #fetch: typeof fetch;
  readonly #tokens: AccessTokenProvider;

  constructor(
    configuration: CloudRunClientConfiguration,
    tokens: AccessTokenProvider,
    providerFetch: typeof fetch = fetch,
  ) {
    this.#configuration = configuration;
    this.#tokens = tokens;
    this.#fetch = providerFetch;
  }

  async createJob(jobId: string, manifest: CloudRunJobManifest): Promise<ProviderMutation> {
    return this.#mutation(
      "POST",
      `${this.#collection()}?jobId=${encodeURIComponent(jobId)}`,
      manifest,
    );
  }

  async runJob(job: ProviderJob): Promise<ProviderMutation> {
    return this.#mutation("POST", `${this.#resource(job.ref)}:run`, { etag: job.etag });
  }

  async cancelExecution(execution: ProviderExecution): Promise<ProviderMutation> {
    return this.#mutation("POST", `${this.#resource(execution.ref)}:cancel`, {
      etag: execution.etag,
    });
  }

  async deleteExecution(execution: ProviderExecution): Promise<ProviderMutation> {
    return this.#mutation(
      "DELETE",
      `${this.#resource(execution.ref)}?etag=${encodeURIComponent(execution.etag)}`,
    );
  }

  async deleteJob(job: ProviderJob): Promise<ProviderMutation> {
    return this.#mutation(
      "DELETE",
      `${this.#resource(job.ref)}?etag=${encodeURIComponent(job.etag)}`,
    );
  }

  async getJob(jobId: string): Promise<ProviderJobRead> {
    const response = await this.#request(
      "GET",
      `${this.#collection()}/${encodeURIComponent(jobId)}`,
    );
    if (response === null) return { outcome: "unavailable" };
    if (response.status === 404) return { outcome: "not_found" };
    if (response.status !== 200) return { outcome: "unavailable" };
    const parsed = jobSchema.safeParse(response.value);
    if (!parsed.success) return { outcome: "unavailable" };
    return {
      outcome: "found",
      job: {
        ref: parsed.data.name,
        uid: parsed.data.uid,
        etag: parsed.data.etag,
        ready:
          parsed.data.reconciling !== true &&
          parsed.data.terminalCondition?.state === "CONDITION_SUCCEEDED",
        manifest: {
          binaryAuthorization: { useDefault: true },
          labels: parsed.data.labels,
          template: parsed.data.template,
        },
      },
    };
  }

  async getOperation(operationRef: string): Promise<ProviderOperationRead> {
    const response = await this.#request("GET", this.#resource(operationRef));
    if (response?.status !== 200) return { outcome: "unavailable" };
    const parsed = operationSchema.safeParse(response.value);
    if (!parsed.success || parsed.data.name !== operationRef) return { outcome: "unavailable" };
    if (parsed.data.done !== true) return { outcome: "pending" };
    if (parsed.data.error === undefined) return { outcome: "succeeded" };
    return {
      outcome: "failed",
      errorKind:
        parsed.data.error.code === 429 || parsed.data.error.code >= 500 ? "retryable" : "permanent",
    };
  }

  async listExecutions(jobId: string): Promise<ProviderExecutionList> {
    const response = await this.#request(
      "GET",
      `${this.#collection()}/${encodeURIComponent(jobId)}/executions?pageSize=2`,
    );
    if (response?.status !== 200) return { outcome: "unavailable" };
    const parsed = executionListSchema.safeParse(response.value);
    if (!parsed.success || parsed.data.nextPageToken !== undefined)
      return { outcome: "unavailable" };
    const jobRef = this.#jobRef(jobId);
    const executionPrefix = `${jobRef}/executions/`;
    if (
      (parsed.data.executions ?? []).some((execution) => {
        const executionId = execution.name.slice(executionPrefix.length);
        return (
          (execution.job !== jobId && execution.job !== jobRef) ||
          !execution.name.startsWith(executionPrefix) ||
          executionId.length === 0 ||
          executionId.includes("/") ||
          executionId.includes("?") ||
          executionId.includes("#")
        );
      })
    ) {
      return { outcome: "unavailable" };
    }
    return {
      outcome: "found",
      executions: (parsed.data.executions ?? []).map((execution) => ({
        ref: execution.name,
        uid: execution.uid,
        etag: execution.etag,
        jobRef,
        status: this.#executionStatus(execution),
        taskCount: execution.taskCount,
        parallelism: execution.parallelism,
        retriedCount: execution.retriedCount ?? 0,
      })),
    };
  }

  #collection(): string {
    return `https://run.googleapis.com/v2/projects/${this.#configuration.projectId}/locations/${this.#configuration.region}/jobs`;
  }

  #jobRef(jobId: string): string {
    return `projects/${this.#configuration.projectId}/locations/${this.#configuration.region}/jobs/${jobId}`;
  }

  #resource(reference: string): string {
    const prefix = `projects/${this.#configuration.projectId}/locations/${this.#configuration.region}/`;
    if (!reference.startsWith(prefix) || reference.includes("?") || reference.includes("#")) {
      throw new Error("provider reference escaped configured scope");
    }
    return `https://run.googleapis.com/v2/${reference}`;
  }

  #executionStatus(execution: z.infer<typeof executionSchema>): ProviderExecution["status"] {
    if ((execution.cancelledCount ?? 0) > 0) return "cancelled";
    if ((execution.failedCount ?? 0) > 0) return "failed";
    if ((execution.succeededCount ?? 0) === 1) return "succeeded";
    if ((execution.runningCount ?? 0) > 0) return "running";
    return "pending";
  }

  async #mutation(
    method: "DELETE" | "POST",
    url: string,
    body?: unknown,
  ): Promise<ProviderMutation> {
    const response = await this.#request(method, url, body);
    if (response === null) return { outcome: "unknown" };
    if (response.status === 409) return { outcome: "conflict" };
    if (response.status === 429 || response.status >= 500) {
      return { outcome: "rejected", errorKind: "retryable" };
    }
    if (response.status < 200 || response.status >= 300) {
      return { outcome: "rejected", errorKind: "permanent" };
    }
    const parsed = operationSchema.safeParse(response.value);
    return parsed.success && this.#isScopedOperation(parsed.data.name)
      ? { outcome: "accepted", operationRef: parsed.data.name }
      : { outcome: "unknown" };
  }

  #isScopedOperation(reference: string): boolean {
    return reference.startsWith(
      `projects/${this.#configuration.projectId}/locations/${this.#configuration.region}/operations/`,
    );
  }

  async #request(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<ProviderHttpResponse | null> {
    const abort = new AbortController();
    const timeout = setTimeout(() => {
      abort.abort();
    }, PROVIDER_TIMEOUT_MS);
    try {
      const token = await this.#tokens.getAccessToken();
      const response = await this.#fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: abort.signal,
      });
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400))
        return null;
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength > MAX_PROVIDER_RESPONSE_BYTES) return null;
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_PROVIDER_RESPONSE_BYTES) return null;
      let value: unknown = {};
      if (text !== "") {
        try {
          value = JSON.parse(text) as unknown;
        } catch {
          return null;
        }
      }
      return { status: response.status, value };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
