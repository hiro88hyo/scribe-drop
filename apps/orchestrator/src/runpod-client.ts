import {
  runpodRunRequestSchema,
  runpodRunResponseSchema,
  type RunpodRunRequest,
} from "@scribe-drop/contracts";

const RUNPOD_API_ORIGIN = "https://api.runpod.ai";
const RUNPOD_SUBMISSION_TIMEOUT_MS = 15_000;

export type RunpodSubmissionResult =
  | {
      readonly outcome: "accepted";
      readonly runpodJobId: string;
    }
  | {
      readonly outcome: "rejected";
    }
  | {
      readonly outcome: "unknown";
    };

export interface RunpodClient {
  submit(request: RunpodRunRequest): Promise<RunpodSubmissionResult>;
}

export interface RunpodClientOptions {
  readonly apiKey: string;
  readonly endpointId: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

export function createRunpodClient(options: RunpodClientOptions): RunpodClient {
  const fetchImplementation = options.fetch ?? fetch;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? RUNPOD_SUBMISSION_TIMEOUT_MS;
  const runUrl = `${RUNPOD_API_ORIGIN}/v2/${encodeURIComponent(options.endpointId)}/run`;

  return {
    async submit(untrustedRequest) {
      const request = runpodRunRequestSchema.parse(untrustedRequest);
      let response: Response;
      try {
        response = await fetchImplementation(runUrl, {
          body: JSON.stringify(request),
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMilliseconds),
        });
      } catch {
        return { outcome: "unknown" };
      }

      if (!response.ok) {
        return { outcome: "rejected" };
      }

      try {
        const parsed = runpodRunResponseSchema.safeParse(await response.json());
        return parsed.success
          ? { outcome: "accepted", runpodJobId: parsed.data.id }
          : { outcome: "unknown" };
      } catch {
        return { outcome: "unknown" };
      }
    },
  };
}
