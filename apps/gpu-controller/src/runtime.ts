import { z } from "zod";

import type { ControllerClock, ControllerHmacKeys } from "./authentication.js";
import { CloudRunJobsClient, type AccessTokenProvider } from "./cloud-run-client.js";
import { GpuControllerService } from "./controller-service.js";
import {
  FirestoreControlStore,
  firestoreDatabaseConfigurationSchema,
  firestoreSyntheticAuthorizationSchema,
  type FirestoreControlDatabase,
} from "./firestore-control-store.js";
import { createControllerHttpHandler, type ControllerLogSink } from "./http-handler.js";
import { fixedPolicyConfigurationSchema } from "./provider.js";

export const controllerRuntimeConfigurationSchema = z
  .object({
    authorization: firestoreSyntheticAuthorizationSchema,
    firestore: firestoreDatabaseConfigurationSchema,
    manifest: fixedPolicyConfigurationSchema,
  })
  .strict()
  .superRefine((configuration, context) => {
    if (configuration.authorization.environment !== configuration.manifest.environment) {
      context.addIssue({
        code: "custom",
        message: "authorization and manifest environments must match",
        path: ["authorization", "environment"],
      });
    }
    if (configuration.firestore.projectId !== configuration.manifest.projectId) {
      context.addIssue({
        code: "custom",
        message: "Firestore and Cloud Run projects must match",
        path: ["firestore", "projectId"],
      });
    }
    const imagePrefix = `asia-southeast1-docker.pkg.dev/${configuration.manifest.projectId}/`;
    if (!configuration.manifest.imageDigest.startsWith(imagePrefix)) {
      context.addIssue({
        code: "custom",
        message: "runtime image must belong to the configured project",
        path: ["manifest", "imageDigest"],
      });
    }
    const serviceAccountSuffix = `@${configuration.manifest.projectId}.iam.gserviceaccount.com`;
    if (!configuration.manifest.runtimeServiceAccount.endsWith(serviceAccountSuffix)) {
      context.addIssue({
        code: "custom",
        message: "runtime service account must belong to the configured project",
        path: ["manifest", "runtimeServiceAccount"],
      });
    }
    const authorization = configuration.authorization;
    const disabled =
      authorization.epoch === "disabled" &&
      authorization.validUntil === "1970-01-01T00:00:00.000Z" &&
      authorization.maxExecutions === 0 &&
      authorization.maxRequestsPerMinute === 0 &&
      authorization.maxWorstCaseJpy === 0 &&
      authorization.worstCaseJpyPerExecution === 0;
    const enabled =
      authorization.epoch !== "disabled" &&
      Date.parse(authorization.validUntil) > 0 &&
      authorization.maxExecutions > 0 &&
      authorization.maxRequestsPerMinute > 0 &&
      authorization.maxWorstCaseJpy > 0 &&
      authorization.worstCaseJpyPerExecution > 0 &&
      authorization.worstCaseJpyPerExecution <= authorization.maxWorstCaseJpy;
    if (!disabled && !enabled) {
      context.addIssue({
        code: "custom",
        message: "synthetic authorization must be exactly disabled or coherently finite",
        path: ["authorization"],
      });
    }
  });

export type ControllerRuntimeConfiguration = z.infer<typeof controllerRuntimeConfigurationSchema>;

export interface ControllerRuntimeDependencies {
  readonly clock: ControllerClock;
  readonly database: FirestoreControlDatabase;
  readonly keys: ControllerHmacKeys;
  readonly logger: ControllerLogSink;
  readonly providerFetch?: typeof fetch;
  readonly tokens: AccessTokenProvider;
}

export function createControllerRuntimeHandler(
  configuration: ControllerRuntimeConfiguration,
  dependencies: ControllerRuntimeDependencies,
): (request: Request) => Promise<Response> {
  const parsed = controllerRuntimeConfigurationSchema.parse(configuration);
  const providerConfiguration = {
    projectId: parsed.manifest.projectId,
    region: "asia-southeast1",
  } as const;
  const provider =
    dependencies.providerFetch === undefined
      ? new CloudRunJobsClient(providerConfiguration, dependencies.tokens)
      : new CloudRunJobsClient(
          providerConfiguration,
          dependencies.tokens,
          dependencies.providerFetch,
        );
  const store = new FirestoreControlStore(parsed.authorization, dependencies.database);
  const service = new GpuControllerService({
    clock: dependencies.clock,
    environment: parsed.manifest.environment,
    manifestConfiguration: parsed.manifest,
    provider,
    store,
  });
  return createControllerHttpHandler({
    clock: dependencies.clock,
    keys: dependencies.keys,
    logger: dependencies.logger,
    service,
  });
}
