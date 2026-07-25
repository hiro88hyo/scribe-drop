import { createStructuredLogger, type DeploymentEnvironment } from "@scribe-drop/observability";

import type { WebPagesFunction, WebRequestData } from "../web-context.js";
import {
  verifyAccessJwt,
  type AccessJwtVerifier,
  type AuthContext,
} from "../security/access-jwt.js";
import {
  parseWebSecurityConfig,
  type WebSecurityEnvironment,
} from "../security/security-config.js";
import { isUnsafeMethod, verifyUnsafeRequest } from "../security/request-security.js";
import { createApiErrorResponse } from "./api-error.js";
import { applyApiSecurityHeaders } from "./security-headers.js";

const INTERNAL_ERROR_MESSAGE = "リクエストを処理できませんでした。";
const INVALID_CONTENT_TYPE_MESSAGE = "JSON形式のリクエストが必要です。";
const UNAUTHENTICATED_MESSAGE = "認証が必要です。";
const FORBIDDEN_MESSAGE = "リクエストを許可できません。";

interface ApiBoundaryContext {
  readonly data: WebRequestData;
  readonly env: WebSecurityEnvironment;
  readonly next: () => Promise<Response>;
  readonly request: Request;
}

interface RequestFailure {
  readonly environment: DeploymentEnvironment;
  readonly requestId: string;
}

export interface ApiBoundaryDependencies {
  readonly createRequestId?: () => string;
  readonly logRequestFailure?: (failure: RequestFailure) => void;
  readonly now?: () => Date;
  readonly verifyAccessToken?: AccessJwtVerifier;
}

function normalizeEnvironment(value: string): DeploymentEnvironment {
  switch (value) {
    case "local":
    case "production":
    case "staging":
      return value;
    default:
      return "local";
  }
}

const defaultDependencies = {
  createRequestId: () => crypto.randomUUID(),
  logRequestFailure: ({ environment, requestId }) => {
    const logger = createStructuredLogger({
      environment,
      service: "web",
      sink: (serializedRecord) => {
        console.error(serializedRecord);
      },
    });
    logger.error("api_request_failed", {
      errorCode: "INTERNAL_ERROR",
      requestId,
    });
  },
} satisfies Required<Pick<ApiBoundaryDependencies, "createRequestId" | "logRequestFailure">>;

export async function applyApiBoundary(
  context: ApiBoundaryContext,
  dependencies: ApiBoundaryDependencies = {},
): Promise<Response> {
  const createRequestId = dependencies.createRequestId ?? defaultDependencies.createRequestId;
  const logRequestFailure = dependencies.logRequestFailure ?? defaultDependencies.logRequestFailure;
  const now = dependencies.now ?? (() => new Date());
  const verifyAccessToken = dependencies.verifyAccessToken ?? verifyAccessJwt;
  const requestId = createRequestId();
  context.data.requestId = requestId;

  try {
    const configResult = parseWebSecurityConfig(context.env);
    if (!configResult.ok) {
      logRequestFailure({
        environment: normalizeEnvironment(context.env.APP_ENV),
        requestId,
      });
      return applyApiSecurityHeaders(
        createApiErrorResponse({
          code: "INTERNAL_ERROR",
          message: INTERNAL_ERROR_MESSAGE,
          requestId,
          status: 500,
        }),
        requestId,
      );
    }

    const authentication = await verifyAccessToken(context.request, configResult.config);
    if (authentication.status === "dependency_failure") {
      logRequestFailure({
        environment: configResult.config.appEnvironment,
        requestId,
      });
      return applyApiSecurityHeaders(
        createApiErrorResponse({
          code: "INTERNAL_ERROR",
          message: INTERNAL_ERROR_MESSAGE,
          requestId,
          status: 500,
        }),
        requestId,
      );
    }
    if (authentication.status === "unauthenticated") {
      return applyApiSecurityHeaders(
        createApiErrorResponse({
          code: "UNAUTHENTICATED",
          message: UNAUTHENTICATED_MESSAGE,
          requestId,
          status: 401,
        }),
        requestId,
      );
    }

    context.data.auth = authentication.auth;
    if (isUnsafeMethod(context.request.method)) {
      const csrfResult = await verifyUnsafeRequest(
        context.request,
        authentication.auth,
        configResult.config,
        now().getTime() / 1000,
      );
      if (!csrfResult.ok) {
        const contentTypeFailure = csrfResult.reason === "content_type";
        return applyApiSecurityHeaders(
          createApiErrorResponse({
            code: contentTypeFailure ? "INVALID_REQUEST" : "FORBIDDEN",
            message: contentTypeFailure ? INVALID_CONTENT_TYPE_MESSAGE : FORBIDDEN_MESSAGE,
            requestId,
            status: contentTypeFailure ? 415 : 403,
          }),
          requestId,
        );
      }
    }

    const response = await context.next();
    return applyApiSecurityHeaders(response, requestId);
  } catch {
    logRequestFailure({
      environment: normalizeEnvironment(context.env.APP_ENV),
      requestId,
    });

    return applyApiSecurityHeaders(
      createApiErrorResponse({
        code: "INTERNAL_ERROR",
        message: INTERNAL_ERROR_MESSAGE,
        requestId,
        status: 500,
      }),
      requestId,
    );
  }
}

export function createApiBoundaryMiddleware(
  dependencies: ApiBoundaryDependencies = {},
): WebPagesFunction {
  return (context) => applyApiBoundary(context, dependencies);
}

export function getVerifiedAuthContext(data: WebRequestData): AuthContext {
  if (data.auth === undefined) {
    throw new Error("Verified authentication context is missing");
  }
  return data.auth;
}

export function getRequestId(data: WebRequestData): string {
  if (data.requestId === undefined) {
    throw new Error("Request ID is missing");
  }
  return data.requestId;
}
