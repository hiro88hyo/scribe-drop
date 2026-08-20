import {
  CLOUD_RUN_CONTROLLER_ATTEST_PATH,
  CLOUD_RUN_CONTROLLER_MUTATION_PATH,
  cloudRunControllerAttestationRequestSchema,
  cloudRunControllerAttestationResponseSchema,
} from "@scribe-drop/contracts";
import {
  authenticateControllerRequest,
  digestControllerRequest,
  type ControllerClock,
  type ControllerHmacKeys,
} from "./authentication.js";
import {
  CONTROLLER_POLICY_ID,
  MAX_CONTROLLER_BODY_BYTES,
  parseControllerRequest,
  type ControllerAction,
  type ControllerErrorCode,
} from "./contracts.js";
import type { GpuControllerService } from "./controller-service.js";

const CONTROLLER_PATH = CLOUD_RUN_CONTROLLER_MUTATION_PATH;

export interface ControllerLogRecord {
  readonly event: "controller_request";
  readonly action: ControllerAction | "attest" | null;
  readonly outcome: "accepted" | "rejected";
  readonly errorCode: ControllerErrorCode | null;
  readonly policyId: typeof CONTROLLER_POLICY_ID;
  readonly durationMs: number;
}

export interface ControllerLogSink {
  emit(record: ControllerLogRecord): void;
}

async function readBoundedBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_CONTROLLER_BODY_BYTES) throw new Error("INVALID_REQUEST");
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_CONTROLLER_BODY_BYTES) {
      await reader.cancel();
      throw new Error("INVALID_REQUEST");
    }
    chunks.push(result.value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}

function errorResponse(errorCode: ControllerErrorCode, status: number): Response {
  return Response.json(
    { schemaVersion: 1, outcome: "rejected", errorCode },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export function createControllerHttpHandler(input: {
  readonly clock: ControllerClock;
  readonly keys: ControllerHmacKeys;
  readonly logger: ControllerLogSink;
  readonly service: GpuControllerService;
}): (request: Request) => Promise<Response> {
  return async (request): Promise<Response> => {
    const startedAt = input.clock.now().getTime();
    let action: ControllerAction | "attest" | null = null;
    let errorCode: ControllerErrorCode | null = null;
    try {
      const url = new URL(request.url);
      if (
        request.method !== "POST" ||
        (url.pathname !== CONTROLLER_PATH && url.pathname !== CLOUD_RUN_CONTROLLER_ATTEST_PATH) ||
        url.search !== "" ||
        request.headers.get("content-type") !== "application/json"
      ) {
        errorCode = "INVALID_REQUEST";
        return errorResponse(errorCode, 400);
      }
      const body = await readBoundedBody(request);
      if (url.pathname === CLOUD_RUN_CONTROLLER_ATTEST_PATH) {
        action = "attest";
        let parsed: ReturnType<typeof cloudRunControllerAttestationRequestSchema.parse>;
        try {
          parsed = cloudRunControllerAttestationRequestSchema.parse(JSON.parse(body) as unknown);
        } catch {
          throw new Error("INVALID_REQUEST");
        }
        const authentication = await authenticateControllerRequest(
          {
            method: request.method,
            path: url.pathname,
            body,
            keyId: request.headers.get("x-scribe-key-id"),
            signature: request.headers.get("x-scribe-signature"),
            request: parsed,
          },
          input.clock,
          input.keys,
        );
        if (authentication !== "authenticated") {
          errorCode = authentication === "expired" ? "EXPIRED_REQUEST" : "AUTHENTICATION_FAILED";
          return errorResponse(errorCode, 401);
        }
        const response = cloudRunControllerAttestationResponseSchema.parse(
          await input.service.attest(parsed),
        );
        return Response.json(response, {
          status: 200,
          headers: { "Cache-Control": "no-store" },
        });
      }
      const parsed = parseControllerRequest(body);
      action = parsed.action;
      const authentication = await authenticateControllerRequest(
        {
          method: request.method,
          path: url.pathname,
          body,
          keyId: request.headers.get("x-scribe-key-id"),
          signature: request.headers.get("x-scribe-signature"),
          request: parsed,
        },
        input.clock,
        input.keys,
      );
      if (authentication !== "authenticated") {
        errorCode = authentication === "expired" ? "EXPIRED_REQUEST" : "AUTHENTICATION_FAILED";
        return errorResponse(errorCode, 401);
      }
      const response = await input.service.execute(parsed, await digestControllerRequest(parsed));
      errorCode = response.errorCode;
      return Response.json(response, {
        status: response.outcome === "rejected" ? 409 : 200,
        headers: { "Cache-Control": "no-store" },
      });
    } catch {
      errorCode = action === null ? "INVALID_REQUEST" : "INTERNAL_ERROR";
      return errorResponse(errorCode, action === null ? 400 : 500);
    } finally {
      input.logger.emit({
        event: "controller_request",
        action,
        outcome: errorCode === null ? "accepted" : "rejected",
        errorCode,
        policyId: CONTROLLER_POLICY_ID,
        durationMs: Math.max(0, input.clock.now().getTime() - startedAt),
      });
    }
  };
}
