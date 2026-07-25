import type { ApiErrorResponse, PublicErrorCode } from "@scribe-drop/contracts";

export interface ApiErrorOptions {
  readonly code: PublicErrorCode;
  readonly message: string;
  readonly requestId: string;
  readonly status: number;
}

export function createApiErrorResponse(options: ApiErrorOptions): Response {
  const body = {
    error: {
      code: options.code,
      message: options.message,
      requestId: options.requestId,
    },
  } satisfies ApiErrorResponse;

  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    status: options.status,
  });
}
