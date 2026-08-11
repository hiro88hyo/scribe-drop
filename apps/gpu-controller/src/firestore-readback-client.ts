import type { AccessTokenProvider } from "./cloud-run-client.js";
import {
  controllerFirestoreDeploymentPlanSchema,
  firestoreDatabaseReadbackSchema,
  firestoreTtlFieldReadbackSchema,
  firestoreTtlPolicyListReadbackSchema,
  verifyControllerFirestoreReadback,
  type ControllerFirestoreDeploymentPlan,
  type ControllerFirestoreReadbackEvidence,
} from "./firestore-deployment.js";
import {
  BoundedGoogleControlPlaneReadClient,
  type GoogleControlPlaneReadRequest,
} from "./google-control-plane-read.js";

export type ControllerFirestoreReadbackKey =
  "database" | "executionTtl" | "requestTtl" | "ttlPolicies";

function requireSnapshotValue(
  snapshot: ReadonlyMap<ControllerFirestoreReadbackKey, unknown>,
  key: ControllerFirestoreReadbackKey,
): unknown {
  if (!snapshot.has(key)) throw new Error("Firestore read-back snapshot is incomplete");
  return snapshot.get(key);
}

export function controllerFirestoreStabilityProjection(
  key: ControllerFirestoreReadbackKey,
  value: unknown,
): unknown {
  if (key === "database") {
    const parsed = firestoreDatabaseReadbackSchema.parse(value);
    return { ...parsed, earliestVersionTime: "volatile-output-only" };
  }
  if (key === "ttlPolicies") {
    const parsed = firestoreTtlPolicyListReadbackSchema.parse(value);
    return {
      ...parsed,
      fields: [...parsed.fields].sort((left, right) => left.name.localeCompare(right.name)),
    };
  }
  return firestoreTtlFieldReadbackSchema.parse(value);
}

export function createControllerFirestoreReadbackRequests(
  plan: ControllerFirestoreDeploymentPlan,
): readonly GoogleControlPlaneReadRequest<ControllerFirestoreReadbackKey>[] {
  const expected = controllerFirestoreDeploymentPlanSchema.parse(plan);
  return [
    {
      key: "database",
      method: "GET",
      url: `https://firestore.googleapis.com/v1/${expected.database.name}`,
    },
    {
      key: "ttlPolicies",
      method: "GET",
      url: `https://firestore.googleapis.com/v1/${expected.database.name}/collectionGroups/-/fields?filter=ttlConfig%3A*&pageSize=3`,
    },
    {
      key: "requestTtl",
      method: "GET",
      url: `https://firestore.googleapis.com/v1/${expected.ttlFields[0].name}`,
    },
    {
      key: "executionTtl",
      method: "GET",
      url: `https://firestore.googleapis.com/v1/${expected.ttlFields[1].name}`,
    },
  ];
}

export class GoogleControllerFirestoreReadbackClient {
  readonly #reads: BoundedGoogleControlPlaneReadClient;

  constructor(tokens: AccessTokenProvider, controlPlaneFetch: typeof fetch = fetch) {
    this.#reads = new BoundedGoogleControlPlaneReadClient(tokens, controlPlaneFetch);
  }

  async readAndVerify(
    plan: ControllerFirestoreDeploymentPlan,
  ): Promise<ControllerFirestoreReadbackEvidence> {
    const expected = controllerFirestoreDeploymentPlanSchema.parse(plan);
    const projectId = expected.database.name.split("/")[1];
    if (projectId === undefined) throw new Error("Firestore project identity is missing");
    const requests = createControllerFirestoreReadbackRequests(expected);
    const snapshot = await this.#reads.stableSnapshot(
      projectId,
      requests,
      controllerFirestoreStabilityProjection,
    );
    return verifyControllerFirestoreReadback(expected, {
      database: requireSnapshotValue(snapshot, "database"),
      ttlFields: [
        requireSnapshotValue(snapshot, "requestTtl"),
        requireSnapshotValue(snapshot, "executionTtl"),
      ],
      ttlPolicies: requireSnapshotValue(snapshot, "ttlPolicies"),
    });
  }
}
