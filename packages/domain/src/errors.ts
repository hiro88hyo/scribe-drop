export const PUBLIC_ERROR_CODES = [
  "INVALID_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "UNSUPPORTED_MEDIA_TYPE",
  "FILE_TOO_LARGE",
  "TOO_MANY_ACTIVE_JOBS",
  "UPLOAD_EXPIRED",
  "SOURCE_NOT_FOUND",
  "SOURCE_SIZE_MISMATCH",
  "SOURCE_ETAG_CHANGED",
  "INVALID_STATE",
  "PROCESSING_FAILED",
  "ARTIFACT_NOT_READY",
  "INTERNAL_ERROR",
] as const;

export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

export type ErrorKind =
  | "authentication"
  | "authorization"
  | "conflict"
  | "dependency"
  | "internal"
  | "not-found"
  | "rate-limit"
  | "validation";

export interface PublicErrorDescriptor {
  readonly httpStatus: number;
  readonly kind: ErrorKind;
  readonly retryable: boolean;
}

export const PUBLIC_ERROR_DESCRIPTORS: Readonly<Record<PublicErrorCode, PublicErrorDescriptor>> = {
  ARTIFACT_NOT_READY: { httpStatus: 409, kind: "conflict", retryable: true },
  CONFLICT: { httpStatus: 409, kind: "conflict", retryable: false },
  FILE_TOO_LARGE: { httpStatus: 413, kind: "validation", retryable: false },
  FORBIDDEN: { httpStatus: 403, kind: "authorization", retryable: false },
  INTERNAL_ERROR: { httpStatus: 500, kind: "internal", retryable: true },
  INVALID_REQUEST: { httpStatus: 400, kind: "validation", retryable: false },
  INVALID_STATE: { httpStatus: 409, kind: "conflict", retryable: false },
  NOT_FOUND: { httpStatus: 404, kind: "not-found", retryable: false },
  PROCESSING_FAILED: { httpStatus: 422, kind: "dependency", retryable: true },
  RATE_LIMITED: { httpStatus: 429, kind: "rate-limit", retryable: true },
  SOURCE_ETAG_CHANGED: { httpStatus: 409, kind: "conflict", retryable: false },
  SOURCE_NOT_FOUND: { httpStatus: 422, kind: "dependency", retryable: true },
  SOURCE_SIZE_MISMATCH: { httpStatus: 422, kind: "validation", retryable: false },
  TOO_MANY_ACTIVE_JOBS: { httpStatus: 409, kind: "conflict", retryable: true },
  UNAUTHENTICATED: { httpStatus: 401, kind: "authentication", retryable: false },
  UNSUPPORTED_MEDIA_TYPE: { httpStatus: 415, kind: "validation", retryable: false },
  UPLOAD_EXPIRED: { httpStatus: 410, kind: "conflict", retryable: false },
};

export function getPublicErrorDescriptor(code: PublicErrorCode): PublicErrorDescriptor {
  return PUBLIC_ERROR_DESCRIPTORS[code];
}
