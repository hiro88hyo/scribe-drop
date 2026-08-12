import {
  CLOUD_RUN_CONTROLLER_ACTIONS,
  CLOUD_RUN_CONTROLLER_ERROR_CODES,
  CLOUD_RUN_CONTROLLER_MAX_CLOCK_SKEW_MS,
  CLOUD_RUN_CONTROLLER_MAX_REQUEST_LIFETIME_MS,
  CLOUD_RUN_CONTROLLER_OUTCOMES,
  CLOUD_RUN_RUNTIME_ENVIRONMENTS,
  CLOUD_RUN_RUNTIME_POLICY,
  cloudRunControllerHeadersSchema,
  cloudRunControllerRequestSchema,
  cloudRunControllerResponseSchema,
  type CloudRunControllerAction,
  type CloudRunControllerErrorCode,
  type CloudRunControllerRequest,
  type CloudRunControllerResponse,
} from "@scribe-drop/contracts";

export const CONTROLLER_ACTIONS = CLOUD_RUN_CONTROLLER_ACTIONS;
export const CONTROLLER_ENVIRONMENTS = CLOUD_RUN_RUNTIME_ENVIRONMENTS;
export const CONTROLLER_POLICY_ID = CLOUD_RUN_RUNTIME_POLICY;
export const CONTROLLER_OUTCOMES = CLOUD_RUN_CONTROLLER_OUTCOMES;
export const CONTROLLER_ERROR_CODES = CLOUD_RUN_CONTROLLER_ERROR_CODES;

export type ControllerRequest = CloudRunControllerRequest;
export type ControllerAction = CloudRunControllerAction;
export type ControllerEnvironment = ControllerRequest["environment"];
export type ControllerOutcome = (typeof CONTROLLER_OUTCOMES)[number];
export type ControllerErrorCode = CloudRunControllerErrorCode;
export type ControllerResponse = CloudRunControllerResponse;

export const controllerRequestSchema = cloudRunControllerRequestSchema;
export const controllerResponseSchema = cloudRunControllerResponseSchema;
export const controllerHeadersSchema = cloudRunControllerHeadersSchema;

export const MAX_CONTROLLER_BODY_BYTES = 4_096;
export const MAX_REQUEST_LIFETIME_MS = CLOUD_RUN_CONTROLLER_MAX_REQUEST_LIFETIME_MS;
export const MAX_CLOCK_SKEW_MS = CLOUD_RUN_CONTROLLER_MAX_CLOCK_SKEW_MS;

export function parseControllerRequest(body: string): ControllerRequest {
  if (new TextEncoder().encode(body).byteLength > MAX_CONTROLLER_BODY_BYTES) {
    throw new Error("INVALID_REQUEST");
  }
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new Error("INVALID_REQUEST");
  }
  const result = controllerRequestSchema.safeParse(value);
  if (!result.success) throw new Error("INVALID_REQUEST");
  return result.data;
}
