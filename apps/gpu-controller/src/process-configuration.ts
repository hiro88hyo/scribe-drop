import { z } from "zod";

import { defaultSyntheticAuthorizations, type SyntheticAuthorization } from "./control-store.js";
import { StaticControllerHmacKeys } from "./google-runtime-auth.js";
import {
  controllerRuntimeConfigurationSchema,
  type ControllerRuntimeConfiguration,
} from "./runtime.js";

const canonicalIntegerSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/u)
  .transform((value) => Number(value))
  .pipe(z.number().int().nonnegative());

const portSchema = canonicalIntegerSchema.pipe(z.number().int().min(1).max(65_535));

const authorizationNames = [
  "SCRIBE_DROP_AUTHORIZATION_EPOCH",
  "SCRIBE_DROP_AUTHORIZATION_VALID_UNTIL",
  "SCRIBE_DROP_AUTHORIZATION_MAX_EXECUTIONS",
  "SCRIBE_DROP_AUTHORIZATION_MAX_REQUESTS_PER_MINUTE",
  "SCRIBE_DROP_AUTHORIZATION_MAX_WORST_CASE_JPY",
  "SCRIBE_DROP_AUTHORIZATION_WORST_CASE_JPY_PER_EXECUTION",
] as const;

export interface ControllerProcessConfiguration {
  readonly keys: StaticControllerHmacKeys;
  readonly port: number;
  readonly runtime: ControllerRuntimeConfiguration;
}

function requireValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value === "") throw new Error(`missing controller setting: ${name}`);
  return value;
}

function parseAuthorization(
  environment: NodeJS.ProcessEnv,
  controllerEnvironment: "staging" | "production",
): SyntheticAuthorization {
  const present = authorizationNames.filter((name) => environment[name] !== undefined);
  if (present.length === 0) return defaultSyntheticAuthorizations()[controllerEnvironment];
  if (present.length !== authorizationNames.length) {
    throw new Error("synthetic authorization settings must be all present or all absent");
  }
  return {
    environment: controllerEnvironment,
    epoch: requireValue(environment, "SCRIBE_DROP_AUTHORIZATION_EPOCH"),
    maxExecutions: canonicalIntegerSchema.parse(
      requireValue(environment, "SCRIBE_DROP_AUTHORIZATION_MAX_EXECUTIONS"),
    ),
    maxRequestsPerMinute: canonicalIntegerSchema.parse(
      requireValue(environment, "SCRIBE_DROP_AUTHORIZATION_MAX_REQUESTS_PER_MINUTE"),
    ),
    maxWorstCaseJpy: canonicalIntegerSchema.parse(
      requireValue(environment, "SCRIBE_DROP_AUTHORIZATION_MAX_WORST_CASE_JPY"),
    ),
    validUntil: requireValue(environment, "SCRIBE_DROP_AUTHORIZATION_VALID_UNTIL"),
    worstCaseJpyPerExecution: canonicalIntegerSchema.parse(
      requireValue(environment, "SCRIBE_DROP_AUTHORIZATION_WORST_CASE_JPY_PER_EXECUTION"),
    ),
  };
}

export function parseControllerProcessEnvironment(
  environment: NodeJS.ProcessEnv,
): ControllerProcessConfiguration {
  const controllerEnvironment = z
    .enum(["staging", "production"])
    .parse(requireValue(environment, "APP_ENV"));
  const projectId = requireValue(environment, "SCRIBE_DROP_GCP_PROJECT_ID");
  const runtime = controllerRuntimeConfigurationSchema.parse({
    authorization: parseAuthorization(environment, controllerEnvironment),
    firestore: {
      databaseId: requireValue(environment, "SCRIBE_DROP_FIRESTORE_DATABASE_ID"),
      projectId,
    },
    manifest: {
      environment: controllerEnvironment,
      imageDigest: requireValue(environment, "SCRIBE_DROP_CLOUD_RUN_IMAGE_DIGEST"),
      orchestratorOrigin: requireValue(environment, "SCRIBE_DROP_ORCHESTRATOR_ORIGIN"),
      projectId,
      resultHost: requireValue(environment, "SCRIBE_DROP_RESULT_HOST"),
      runtimeServiceAccount: requireValue(
        environment,
        "SCRIBE_DROP_CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT",
      ),
      sourceHost: requireValue(environment, "SCRIBE_DROP_SOURCE_HOST"),
    },
  });
  const secondary = environment["SCRIBE_DROP_CONTROLLER_HMAC_SECONDARY"];
  return {
    keys: new StaticControllerHmacKeys({
      primary: requireValue(environment, "SCRIBE_DROP_CONTROLLER_HMAC_PRIMARY"),
      ...(secondary === undefined ? {} : { secondary }),
    }),
    port: portSchema.parse(requireValue(environment, "PORT")),
    runtime,
  };
}
