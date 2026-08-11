import {
  cloudRunAckRequestSchema,
  cloudRunAckResponseSchema,
  cloudRunBootstrapRequestSchema,
  cloudRunBootstrapResponseSchema,
  cloudRunClaimRequestSchema,
  cloudRunClaimResponseSchema,
  cloudRunHeartbeatRequestSchema,
  cloudRunHeartbeatResponseSchema,
  cloudRunTerminalRequestSchema,
  cloudRunTerminalResponseSchema,
} from "@scribe-drop/contracts";

import {
  CloudRunRuntimeError,
  type CloudRunRuntimeErrorCode,
  type CloudRunRuntimeService,
} from "./cloud-run-runtime-service.js";

export type CloudRunRuntimeHttpService = Pick<
  CloudRunRuntimeService,
  "acknowledge" | "bootstrap" | "claim" | "heartbeat" | "terminal"
>;

const MAX_RUNTIME_REQUEST_BYTES = 16 * 1024;

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

function errorResponse(
  code: CloudRunRuntimeErrorCode | "INVALID_REQUEST",
  status: number,
): Response {
  return response({ error: { code, message: "Runtime request was rejected." } }, status);
}

type JsonReadResult =
  { readonly success: false } | { readonly success: true; readonly value: unknown };

async function readJson(request: Request): Promise<JsonReadResult> {
  if (!/^application\/json(?:\s*;.*)?$/u.test(request.headers.get("content-type") ?? "")) {
    return { success: false };
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_RUNTIME_REQUEST_BYTES)
  ) {
    return { success: false };
  }
  try {
    const body = await request.text();
    if (!body || new TextEncoder().encode(body).byteLength > MAX_RUNTIME_REQUEST_BYTES) {
      return { success: false };
    }
    return { success: true, value: JSON.parse(body) as unknown };
  } catch {
    return { success: false };
  }
}

export async function handleCloudRunRuntimeRequest(
  request: Request,
  service: CloudRunRuntimeHttpService,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.search !== "") return new Response(null, { status: 404 });
  const body = await readJson(request);
  if (!body.success) return errorResponse("INVALID_REQUEST", 400);
  try {
    switch (url.pathname) {
      case "/internal/cloud-run/bootstrap": {
        const parsed = cloudRunBootstrapRequestSchema.safeParse(body.value);
        if (!parsed.success) return errorResponse("INVALID_REQUEST", 400);
        return response(
          cloudRunBootstrapResponseSchema.parse(await service.bootstrap(parsed.data)),
        );
      }
      case "/internal/cloud-run/claim": {
        const parsed = cloudRunClaimRequestSchema.safeParse(body.value);
        if (!parsed.success) return errorResponse("INVALID_REQUEST", 400);
        return response(cloudRunClaimResponseSchema.parse(await service.claim(parsed.data)));
      }
      case "/internal/cloud-run/ack": {
        const parsed = cloudRunAckRequestSchema.safeParse(body.value);
        if (!parsed.success) return errorResponse("INVALID_REQUEST", 400);
        return response(cloudRunAckResponseSchema.parse(await service.acknowledge(parsed.data)));
      }
      case "/internal/cloud-run/heartbeat": {
        const parsed = cloudRunHeartbeatRequestSchema.safeParse(body.value);
        if (!parsed.success) return errorResponse("INVALID_REQUEST", 400);
        return response(
          cloudRunHeartbeatResponseSchema.parse(await service.heartbeat(parsed.data)),
        );
      }
      case "/internal/cloud-run/terminal": {
        const parsed = cloudRunTerminalRequestSchema.safeParse(body.value);
        if (!parsed.success) return errorResponse("INVALID_REQUEST", 400);
        return response(cloudRunTerminalResponseSchema.parse(await service.terminal(parsed.data)));
      }
      default:
        return new Response(null, { status: 404 });
    }
  } catch (error: unknown) {
    if (error instanceof CloudRunRuntimeError) {
      const status = error.code === "EXECUTION_NOT_FOUND" ? 404 : 403;
      return errorResponse(error.code, status);
    }
    return errorResponse("SESSION_REJECTED", 500);
  }
}
