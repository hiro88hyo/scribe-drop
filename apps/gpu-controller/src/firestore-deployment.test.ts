import { describe, expect, it } from "vitest";

import { defaultSyntheticAuthorizations } from "./control-store.js";
import {
  createControllerFirestoreDeploymentPlan,
  verifyControllerFirestoreReadback,
  type ControllerFirestoreDeploymentPlan,
  type ControllerFirestoreRawReadback,
} from "./firestore-deployment.js";
import type { ControllerServiceDeploymentConfiguration } from "./service-deployment.js";

function configuration(
  environment: "staging" | "production" = "staging",
): ControllerServiceDeploymentConfiguration {
  const marker = environment === "staging" ? "staging" : "production";
  return {
    authorization: defaultSyntheticAuthorizations()[environment],
    controllerImageDigest: `asia-southeast1-docker.pkg.dev/scribe-phase14/controller/runtime@sha256:${"b".repeat(64)}`,
    controllerServiceAccount: "gpu-controller@scribe-phase14.iam.gserviceaccount.com",
    firestore: { databaseId: `scribe-${marker}-controller`, projectId: "scribe-phase14" },
    manifest: {
      environment,
      imageDigest: `asia-southeast1-docker.pkg.dev/scribe-phase14/worker/runtime@sha256:${"a".repeat(64)}`,
      orchestratorOrigin: "https://orchestrator.example.test/",
      projectId: "scribe-phase14",
      resultHost: "storage.example.test",
      runtimeServiceAccount: "gpu-runtime@scribe-phase14.iam.gserviceaccount.com",
      sourceHost: "storage.example.test",
    },
    primaryHmacSecret: { name: `scribe-drop-${marker}-controller-primary`, version: "7" },
    serviceName: `scribe-drop-${marker}-gpu-controller`,
  };
}

export function rawFirestoreReadback(
  plan: ControllerFirestoreDeploymentPlan,
): ControllerFirestoreRawReadback {
  const ancestorField = `${plan.database.name}/collectionGroups/__default__/fields/*`;
  const ttlFields: ControllerFirestoreRawReadback["ttlFields"] = [
    {
      indexConfig: { ancestorField, reverting: false, usesAncestorConfig: true },
      name: plan.ttlFields[0].name,
      ttlConfig: { expirationOffset: plan.ttlFields[0].expirationOffset, state: "ACTIVE" },
    },
    {
      indexConfig: { ancestorField, reverting: false, usesAncestorConfig: true },
      name: plan.ttlFields[1].name,
      ttlConfig: { expirationOffset: plan.ttlFields[1].expirationOffset, state: "ACTIVE" },
    },
  ];
  return {
    database: {
      ...plan.database,
      createTime: "2026-08-11T00:00:00.000Z",
      earliestVersionTime: "2026-08-11T12:00:00.000Z",
      etag: "firestore-database-etag",
      freeTier: false,
      keyPrefix: "",
      uid: "71c68f3d-c626-4f6a-a4e7-b02d89d5a699",
      updateTime: "2026-08-11T00:01:00.000Z",
      versionRetentionPeriod: plan.environment === "production" ? "604800s" : "3600s",
    },
    ttlFields,
    ttlPolicies: { fields: [...ttlFields] },
  };
}

describe("controller Firestore deployment policy", () => {
  it("fixes isolated staging and production database recovery policy", () => {
    const staging = createControllerFirestoreDeploymentPlan(configuration());
    const production = createControllerFirestoreDeploymentPlan(configuration("production"));

    expect(staging.database).toMatchObject({
      deleteProtectionState: "DELETE_PROTECTION_ENABLED",
      locationId: "asia-southeast1",
      pointInTimeRecoveryEnablement: "POINT_IN_TIME_RECOVERY_DISABLED",
      realtimeUpdatesMode: "REALTIME_UPDATES_MODE_ENABLED",
      type: "FIRESTORE_NATIVE",
    });
    expect(production.database.pointInTimeRecoveryEnablement).toBe(
      "POINT_IN_TIME_RECOVERY_ENABLED",
    );
    expect(staging.ttlFields.map(({ name }) => name)).toEqual([
      `${staging.database.name}/collectionGroups/scribe_drop_controller_requests/fields/ttlExpiresAt`,
      `${staging.database.name}/collectionGroups/scribe_drop_controller_executions/fields/ttlExpiresAt`,
    ]);
  });

  it("accepts exact database and active TTL observations", () => {
    const plan = createControllerFirestoreDeploymentPlan(configuration());

    expect(verifyControllerFirestoreReadback(plan, rawFirestoreReadback(plan))).toEqual({
      databaseEtag: "firestore-database-etag",
      databaseUid: "71c68f3d-c626-4f6a-a4e7-b02d89d5a699",
      databaseUpdateTime: "2026-08-11T00:01:00.000Z",
      ttlStates: ["ACTIVE", "ACTIVE"],
    });
  });

  it("accepts Standard database output that omits fixed access-mode defaults", () => {
    const plan = createControllerFirestoreDeploymentPlan(configuration());
    const observed = rawFirestoreReadback(plan);
    delete observed.database.firestoreDataAccessMode;
    delete observed.database.mongodbCompatibleDataAccessMode;

    expect(verifyControllerFirestoreReadback(plan, observed).ttlStates).toEqual([
      "ACTIVE",
      "ACTIVE",
    ]);
  });

  it("accepts live inherited indexes that omit the default ANY_API scope", () => {
    const plan = createControllerFirestoreDeploymentPlan(configuration());
    const observed = rawFirestoreReadback(plan);
    for (const field of observed.ttlFields) {
      if (field.indexConfig === undefined) throw new Error("TTL index fixture is incomplete");
      field.indexConfig.indexes = [
        {
          fields: [{ fieldPath: "ttlExpiresAt", order: "ASCENDING" }],
          queryScope: "COLLECTION",
          state: "READY",
        },
      ];
    }

    expect(verifyControllerFirestoreReadback(plan, observed).ttlStates).toEqual([
      "ACTIVE",
      "ACTIVE",
    ]);
  });

  it("rejects location, TTL convergence, and inherited-index drift", () => {
    const plan = createControllerFirestoreDeploymentPlan(configuration());
    const wrongLocation = rawFirestoreReadback(plan);
    wrongLocation.database.locationId = "us-central1";
    expect(() => verifyControllerFirestoreReadback(plan, wrongLocation)).toThrow(
      "Firestore database read-back does not match the deployment plan",
    );

    const creating = rawFirestoreReadback(plan);
    creating.ttlFields[0].ttlConfig.state = "CREATING";
    expect(() => verifyControllerFirestoreReadback(plan, creating)).toThrow(
      "Firestore TTL policy read-back does not match the deployment plan",
    );

    const indexOverride = rawFirestoreReadback(plan);
    const indexConfig = indexOverride.ttlFields[1].indexConfig;
    if (indexConfig === undefined) throw new Error("TTL index fixture is incomplete");
    indexConfig.usesAncestorConfig = false;
    expect(() => verifyControllerFirestoreReadback(plan, indexOverride)).toThrow(
      "Firestore TTL field index configuration drifted",
    );
  });

  it("rejects an incomplete, extra, or paginated database-wide TTL resource set", () => {
    const plan = createControllerFirestoreDeploymentPlan(configuration());
    const incomplete = rawFirestoreReadback(plan);
    incomplete.ttlPolicies.fields.pop();
    expect(() => verifyControllerFirestoreReadback(plan, incomplete)).toThrow(
      "Firestore TTL policy resource set drifted",
    );

    const extra = rawFirestoreReadback(plan);
    extra.ttlPolicies.fields.push({
      name: `${plan.database.name}/collectionGroups/scribe_drop_controller_requests/fields/unexpected`,
      ttlConfig: { state: "ACTIVE" },
    });
    expect(() => verifyControllerFirestoreReadback(plan, extra)).toThrow();

    const paginated = rawFirestoreReadback(plan);
    paginated.ttlPolicies.nextPageToken = "more-ttl-policies";
    expect(() => verifyControllerFirestoreReadback(plan, paginated)).toThrow(
      "Firestore TTL policy resource set drifted",
    );
  });
});
