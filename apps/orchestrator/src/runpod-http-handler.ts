import {
  runpodClaimRequestSchema,
  runpodHeartbeatRequestSchema,
  runpodInternalErrorResponseSchema,
  type RunpodClaimRequest,
  type RunpodHeartbeatRequest,
} from "@scribe-drop/contracts";
import { createStructuredLogger, type StructuredLogger } from "@scribe-drop/observability";

import { parseRunpodConfig, type RunpodConfigEnvironment } from "./config.js";
import {
  claimRunpodExecution,
  recordRunpodHeartbeat,
  type ClaimServiceResult,
  type HeartbeatServiceResult,
  type RunpodClaimDependencies,
} from "./runpod-claim-service.js";

const MAX_INTERNAL_REQUEST_BYTES = 4 * 1024;

export interface RunpodHttpEnvironment extends RunpodConfigEnvironment {
  readonly SCRIBE_DROP_DB: D1Database;
}

export interface RunpodHttpDependencies {
  readonly claim?: (
    request: RunpodClaimRequest,
    environment: RunpodHttpEnvironment,
    dependencies: RunpodClaimDependencies,
  ) => Promise<ClaimServiceResult>;
  readonly claimDependencies?: Omit<RunpodClaimDependencies, "logger">;
  readonly heartbeat?: (
    request: RunpodHeartbeatRequest,
    environment: RunpodHttpEnvironment,
    dependencies: Pick<RunpodClaimDependencies, "createRepository" | "logger" | "now">,
  ) => Promise<HeartbeatServiceResult>;
  readonly logger?: StructuredLogger;
  readonly now?: () => Date;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
    status,
  });
}

function errorResponse(
  code: "CLAIM_REJECTED" | "HEARTBEAT_REJECTED" | "INTERNAL_ERROR" | "INVALID_REQUEST",
  message: string,
  status: number,
): Response {
  return jsonResponse(
    runpodInternalErrorResponseSchema.parse({
      error: { code, message },
    }),
    status,
  );
}

type JsonReadResult =
  { readonly success: false } | { readonly success: true; readonly value: unknown };

async function readJson(request: Request): Promise<JsonReadResult> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;.*)?$/u.test(contentType)) {
    return { success: false };
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number.parseInt(declaredLength, 10) > MAX_INTERNAL_REQUEST_BYTES)
  ) {
    return { success: false };
  }
  try {
    const text = await request.text();
    if (
      text.length === 0 ||
      new TextEncoder().encode(text).byteLength > MAX_INTERNAL_REQUEST_BYTES
    ) {
      return { success: false };
    }
    return { success: true, value: JSON.parse(text) as unknown };
  } catch {
    return { success: false };
  }
}

export async function handleRunpodHttpRequest(
  request: Request,
  environment: RunpodHttpEnvironment,
  dependencies: RunpodHttpDependencies = {},
): Promise<Response> {
  const now = dependencies.now ?? (() => new Date());
  const config = parseRunpodConfig(environment);
  const logger =
    dependencies.logger ??
    createStructuredLogger({
      environment: config?.appEnvironment ?? "local",
      now,
      service: "orchestrator",
      sink: (record) => {
        console.log(record);
      },
    });
  if (config === undefined) {
    logger.error("api_request_failed", { errorCode: "INTERNAL_ERROR" });
    return errorResponse("INTERNAL_ERROR", "Request could not be processed.", 500);
  }

  const url = new URL(request.url);
  if (url.search !== "" || request.method !== "POST") {
    return new Response(null, { status: 404 });
  }
  const body = await readJson(request);
  if (!body.success) {
    return errorResponse("INVALID_REQUEST", "Request is invalid.", 400);
  }

  const claimDependencies: RunpodClaimDependencies = {
    logger,
    now,
    ...dependencies.claimDependencies,
  };
  try {
    if (url.pathname === "/internal/runpod/claim") {
      const parsed = runpodClaimRequestSchema.safeParse(body.value);
      if (!parsed.success) {
        return errorResponse("INVALID_REQUEST", "Request is invalid.", 400);
      }
      const result = await (dependencies.claim ?? claimRunpodExecution)(
        parsed.data,
        environment,
        claimDependencies,
      );
      return result.kind === "rejected"
        ? errorResponse("CLAIM_REJECTED", "Claim was rejected.", 403)
        : jsonResponse(result.response);
    }

    if (url.pathname === "/internal/runpod/heartbeat") {
      const parsed = runpodHeartbeatRequestSchema.safeParse(body.value);
      if (!parsed.success) {
        return errorResponse("INVALID_REQUEST", "Request is invalid.", 400);
      }
      const result = await (dependencies.heartbeat ?? recordRunpodHeartbeat)(
        parsed.data,
        environment,
        claimDependencies,
      );
      return result.kind === "rejected"
        ? errorResponse("HEARTBEAT_REJECTED", "Heartbeat was rejected.", 403)
        : jsonResponse(result.response);
    }
    return new Response(null, { status: 404 });
  } catch {
    logger.error("api_request_failed", { errorCode: "INTERNAL_ERROR" });
    return errorResponse("INTERNAL_ERROR", "Request could not be processed.", 500);
  }
}
