import { z } from "zod";

import {
  controllerServiceDeploymentConfigurationSchema,
  type ControllerServiceDeploymentConfiguration,
} from "./service-deployment.js";

const timestampSchema = z.iso.datetime({ offset: true });
const durationSchema = z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?s$/u);
const databaseResourceSchema = z
  .string()
  .regex(/^projects\/[a-z][a-z0-9-]{4,28}\/databases\/[a-z](?:[a-z0-9-]{2,61}[a-z0-9])$/u);
const ttlFieldResourceSchema = z
  .string()
  .regex(
    /^projects\/[a-z][a-z0-9-]{4,28}\/databases\/[a-z](?:[a-z0-9-]{2,61}[a-z0-9])\/collectionGroups\/scribe_drop_controller_(?:requests|executions)\/fields\/ttlExpiresAt$/u,
  );

const ttlFieldPlanSchema = z
  .object({ expirationOffset: z.literal("0s"), name: ttlFieldResourceSchema })
  .strict();

export const controllerFirestoreDeploymentPlanSchema = z
  .object({
    database: z
      .object({
        appEngineIntegrationMode: z.literal("DISABLED"),
        concurrencyMode: z.literal("PESSIMISTIC"),
        databaseEdition: z.literal("STANDARD"),
        deleteProtectionState: z.literal("DELETE_PROTECTION_ENABLED"),
        firestoreDataAccessMode: z.literal("DATA_ACCESS_MODE_ENABLED"),
        locationId: z.literal("asia-southeast1"),
        mongodbCompatibleDataAccessMode: z.literal("DATA_ACCESS_MODE_DISABLED"),
        name: databaseResourceSchema,
        pointInTimeRecoveryEnablement: z.enum([
          "POINT_IN_TIME_RECOVERY_DISABLED",
          "POINT_IN_TIME_RECOVERY_ENABLED",
        ]),
        realtimeUpdatesMode: z.literal("REALTIME_UPDATES_MODE_DISABLED"),
        type: z.literal("FIRESTORE_NATIVE"),
      })
      .strict(),
    environment: z.enum(["staging", "production"]),
    ttlFields: z.tuple([ttlFieldPlanSchema, ttlFieldPlanSchema]),
  })
  .strict()
  .superRefine((plan, context) => {
    const expectedPitr =
      plan.environment === "production"
        ? "POINT_IN_TIME_RECOVERY_ENABLED"
        : "POINT_IN_TIME_RECOVERY_DISABLED";
    if (plan.database.pointInTimeRecoveryEnablement !== expectedPitr) {
      context.addIssue({ code: "custom", message: "Firestore recovery policy drifted" });
    }
    const requestField = `${plan.database.name}/collectionGroups/scribe_drop_controller_requests/fields/ttlExpiresAt`;
    const executionField = `${plan.database.name}/collectionGroups/scribe_drop_controller_executions/fields/ttlExpiresAt`;
    if (plan.ttlFields[0].name !== requestField || plan.ttlFields[1].name !== executionField) {
      context.addIssue({ code: "custom", message: "Firestore TTL resource set drifted" });
    }
  });

export type ControllerFirestoreDeploymentPlan = z.infer<
  typeof controllerFirestoreDeploymentPlanSchema
>;

export function createControllerFirestoreDeploymentPlan(
  configuration: ControllerServiceDeploymentConfiguration,
): ControllerFirestoreDeploymentPlan {
  const parsed = controllerServiceDeploymentConfigurationSchema.parse(configuration);
  const databaseName = `projects/${parsed.manifest.projectId}/databases/${parsed.firestore.databaseId}`;
  return controllerFirestoreDeploymentPlanSchema.parse({
    database: {
      appEngineIntegrationMode: "DISABLED",
      concurrencyMode: "PESSIMISTIC",
      databaseEdition: "STANDARD",
      deleteProtectionState: "DELETE_PROTECTION_ENABLED",
      firestoreDataAccessMode: "DATA_ACCESS_MODE_ENABLED",
      locationId: "asia-southeast1",
      mongodbCompatibleDataAccessMode: "DATA_ACCESS_MODE_DISABLED",
      name: databaseName,
      pointInTimeRecoveryEnablement:
        parsed.manifest.environment === "production"
          ? "POINT_IN_TIME_RECOVERY_ENABLED"
          : "POINT_IN_TIME_RECOVERY_DISABLED",
      realtimeUpdatesMode: "REALTIME_UPDATES_MODE_DISABLED",
      type: "FIRESTORE_NATIVE",
    },
    environment: parsed.manifest.environment,
    ttlFields: [
      {
        expirationOffset: "0s",
        name: `${databaseName}/collectionGroups/scribe_drop_controller_requests/fields/ttlExpiresAt`,
      },
      {
        expirationOffset: "0s",
        name: `${databaseName}/collectionGroups/scribe_drop_controller_executions/fields/ttlExpiresAt`,
      },
    ],
  });
}

const indexFieldSchema = z
  .object({
    arrayConfig: z.literal("CONTAINS").optional(),
    fieldPath: z.string().min(1).max(1500).optional(),
    order: z.enum(["ASCENDING", "DESCENDING"]).optional(),
    searchConfig: z.never().optional(),
    vectorConfig: z.never().optional(),
  })
  .strict()
  .superRefine((field, context) => {
    if (Number(field.order !== undefined) + Number(field.arrayConfig !== undefined) !== 1) {
      context.addIssue({ code: "custom", message: "Firestore index field mode is invalid" });
    }
  });

const indexSchema = z
  .object({
    apiScope: z.literal("ANY_API"),
    density: z.enum(["DENSITY_UNSPECIFIED", "SPARSE_ALL"]).optional(),
    fields: z.array(indexFieldSchema).min(1).max(100),
    multikey: z.literal(false).optional(),
    name: z.string().max(1024).optional(),
    queryScope: z.enum(["COLLECTION", "COLLECTION_GROUP"]),
    searchIndexOptions: z.never().optional(),
    shardCount: z.number().int().nonnegative().optional(),
    state: z.literal("READY"),
    unique: z.literal(false).optional(),
  })
  .strict();

const indexConfigSchema = z
  .object({
    ancestorField: z.string().min(1).max(1024).optional(),
    indexes: z.array(indexSchema).optional(),
    reverting: z.boolean().optional(),
    usesAncestorConfig: z.boolean().optional(),
  })
  .strict();

export const firestoreDatabaseReadbackSchema = z
  .object({
    appEngineIntegrationMode: z.enum([
      "APP_ENGINE_INTEGRATION_MODE_UNSPECIFIED",
      "ENABLED",
      "DISABLED",
    ]),
    cmekConfig: z.never().optional(),
    concurrencyMode: z.enum([
      "CONCURRENCY_MODE_UNSPECIFIED",
      "OPTIMISTIC",
      "PESSIMISTIC",
      "OPTIMISTIC_WITH_ENTITY_GROUPS",
    ]),
    createTime: timestampSchema,
    databaseEdition: z.enum(["DATABASE_EDITION_UNSPECIFIED", "STANDARD", "ENTERPRISE"]),
    deleteProtectionState: z.enum([
      "DELETE_PROTECTION_STATE_UNSPECIFIED",
      "DELETE_PROTECTION_DISABLED",
      "DELETE_PROTECTION_ENABLED",
    ]),
    deleteTime: z.never().optional(),
    earliestVersionTime: timestampSchema,
    etag: z.string().min(1).max(1024),
    firestoreDataAccessMode: z.enum([
      "DATA_ACCESS_MODE_UNSPECIFIED",
      "DATA_ACCESS_MODE_ENABLED",
      "DATA_ACCESS_MODE_DISABLED",
    ]),
    freeTier: z.boolean().optional(),
    keyPrefix: z.string().max(1024).optional(),
    locationId: z.string().min(1).max(128),
    mongodbCompatibleDataAccessMode: z.enum([
      "DATA_ACCESS_MODE_UNSPECIFIED",
      "DATA_ACCESS_MODE_ENABLED",
      "DATA_ACCESS_MODE_DISABLED",
    ]),
    name: databaseResourceSchema,
    pointInTimeRecoveryEnablement: z.enum([
      "POINT_IN_TIME_RECOVERY_ENABLEMENT_UNSPECIFIED",
      "POINT_IN_TIME_RECOVERY_DISABLED",
      "POINT_IN_TIME_RECOVERY_ENABLED",
    ]),
    previousId: z.never().optional(),
    realtimeUpdatesMode: z.enum([
      "REALTIME_UPDATES_MODE_UNSPECIFIED",
      "REALTIME_UPDATES_MODE_ENABLED",
      "REALTIME_UPDATES_MODE_DISABLED",
    ]),
    sourceInfo: z.never().optional(),
    tags: z.never().optional(),
    type: z.enum(["DATABASE_TYPE_UNSPECIFIED", "FIRESTORE_NATIVE", "DATASTORE_MODE"]),
    uid: z.uuid(),
    updateTime: timestampSchema,
    versionRetentionPeriod: durationSchema,
  })
  .strict();

export const firestoreTtlFieldReadbackSchema = z
  .object({
    indexConfig: indexConfigSchema.optional(),
    name: ttlFieldResourceSchema,
    ttlConfig: z
      .object({
        expirationOffset: durationSchema.optional(),
        state: z.enum(["STATE_UNSPECIFIED", "CREATING", "ACTIVE", "NEEDS_REPAIR"]),
      })
      .strict(),
  })
  .strict();

export const firestoreTtlPolicyListReadbackSchema = z
  .object({
    fields: z.array(firestoreTtlFieldReadbackSchema).max(3),
    nextPageToken: z.string().max(8_192).optional(),
  })
  .strict();

export const controllerFirestoreRawReadbackSchema = z
  .object({
    database: firestoreDatabaseReadbackSchema,
    ttlFields: z.tuple([firestoreTtlFieldReadbackSchema, firestoreTtlFieldReadbackSchema]),
    ttlPolicies: firestoreTtlPolicyListReadbackSchema,
  })
  .strict();

export type ControllerFirestoreRawReadback = z.input<typeof controllerFirestoreRawReadbackSchema>;

export interface ControllerFirestoreReadbackEvidence {
  readonly databaseEtag: string;
  readonly databaseUid: string;
  readonly databaseUpdateTime: string;
  readonly ttlStates: readonly ["ACTIVE", "ACTIVE"];
}

function verifyInheritedIndexing(
  fieldName: string,
  indexConfig: z.infer<typeof indexConfigSchema>,
): void {
  const databaseName = fieldName.slice(0, fieldName.indexOf("/collectionGroups/"));
  if (
    indexConfig.usesAncestorConfig !== true ||
    indexConfig.reverting === true ||
    indexConfig.ancestorField !== `${databaseName}/collectionGroups/__default__/fields/*`
  ) {
    throw new Error("Firestore TTL field index configuration drifted");
  }
}

function verifyTtlField(
  expectedField: ControllerFirestoreDeploymentPlan["ttlFields"][number],
  actualField: z.infer<typeof firestoreTtlFieldReadbackSchema>,
): void {
  if (
    actualField.name !== expectedField.name ||
    actualField.ttlConfig.state !== "ACTIVE" ||
    (actualField.ttlConfig.expirationOffset !== undefined &&
      actualField.ttlConfig.expirationOffset !== expectedField.expirationOffset)
  ) {
    throw new Error("Firestore TTL policy read-back does not match the deployment plan");
  }
  if (actualField.indexConfig !== undefined) {
    verifyInheritedIndexing(actualField.name, actualField.indexConfig);
  }
}

export function verifyControllerFirestoreReadback(
  expectation: ControllerFirestoreDeploymentPlan,
  rawReadback: unknown,
): ControllerFirestoreReadbackEvidence {
  const expected = controllerFirestoreDeploymentPlanSchema.parse(expectation);
  const observed = controllerFirestoreRawReadbackSchema.parse(rawReadback);
  const desiredDatabase = expected.database;
  const actualDatabase = observed.database;
  if (
    actualDatabase.name !== desiredDatabase.name ||
    actualDatabase.locationId !== desiredDatabase.locationId ||
    actualDatabase.type !== desiredDatabase.type ||
    actualDatabase.concurrencyMode !== desiredDatabase.concurrencyMode ||
    actualDatabase.appEngineIntegrationMode !== desiredDatabase.appEngineIntegrationMode ||
    actualDatabase.deleteProtectionState !== desiredDatabase.deleteProtectionState ||
    actualDatabase.databaseEdition !== desiredDatabase.databaseEdition ||
    actualDatabase.realtimeUpdatesMode !== desiredDatabase.realtimeUpdatesMode ||
    actualDatabase.firestoreDataAccessMode !== desiredDatabase.firestoreDataAccessMode ||
    actualDatabase.mongodbCompatibleDataAccessMode !==
      desiredDatabase.mongodbCompatibleDataAccessMode ||
    actualDatabase.pointInTimeRecoveryEnablement !==
      desiredDatabase.pointInTimeRecoveryEnablement ||
    actualDatabase.versionRetentionPeriod !==
      (expected.environment === "production" ? "604800s" : "3600s")
  ) {
    throw new Error("Firestore database read-back does not match the deployment plan");
  }
  const listedTtlFields = [...observed.ttlPolicies.fields].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const expectedTtlFields = [...expected.ttlFields].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  if (
    (observed.ttlPolicies.nextPageToken !== undefined &&
      observed.ttlPolicies.nextPageToken !== "") ||
    listedTtlFields.length !== expectedTtlFields.length ||
    new Set(listedTtlFields.map(({ name }) => name)).size !== listedTtlFields.length
  ) {
    throw new Error("Firestore TTL policy resource set drifted");
  }
  for (const [index, expectedField] of expected.ttlFields.entries()) {
    const actualField = observed.ttlFields[index];
    if (actualField === undefined) throw new Error("Firestore TTL policy read-back is incomplete");
    verifyTtlField(expectedField, actualField);
  }
  for (const [index, expectedField] of expectedTtlFields.entries()) {
    const actualField = listedTtlFields[index];
    if (actualField === undefined) throw new Error("Firestore TTL policy list is incomplete");
    verifyTtlField(expectedField, actualField);
  }
  return {
    databaseEtag: actualDatabase.etag,
    databaseUid: actualDatabase.uid,
    databaseUpdateTime: actualDatabase.updateTime,
    ttlStates: ["ACTIVE", "ACTIVE"],
  };
}
