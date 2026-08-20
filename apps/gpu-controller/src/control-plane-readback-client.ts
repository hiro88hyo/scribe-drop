import type { AccessTokenProvider } from "./cloud-run-client.js";
import {
  controllerControlPlaneReadbackExpectationSchema,
  verifyControllerControlPlaneReadback,
  type ControllerControlPlaneReadbackEvidence,
  type ControllerControlPlaneReadbackExpectation,
} from "./control-plane-evidence.js";
import {
  BoundedGoogleControlPlaneReadClient,
  type GoogleControlPlaneReadRequest,
} from "./google-control-plane-read.js";

export type ControllerControlPlaneReadbackKey =
  | "binaryAuthorizationPolicy"
  | "primarySecret"
  | "primarySecretIamPolicy"
  | "primarySecretVersion"
  | "secondarySecret"
  | "secondarySecretIamPolicy"
  | "secondarySecretVersion"
  | "service"
  | "serviceIamPolicy";

function requireSnapshotValue(
  snapshot: ReadonlyMap<ControllerControlPlaneReadbackKey, unknown>,
  key: ControllerControlPlaneReadbackKey,
): unknown {
  if (!snapshot.has(key)) throw new Error("control-plane read-back snapshot is incomplete");
  return snapshot.get(key);
}

export function createControllerControlPlaneReadbackRequests(
  expectation: ControllerControlPlaneReadbackExpectation,
): readonly GoogleControlPlaneReadRequest<ControllerControlPlaneReadbackKey>[] {
  const expected = controllerControlPlaneReadbackExpectationSchema.parse(expectation);
  const deployment = expected.deployment;
  const projectId = deployment.manifest.projectId;
  const serviceResource = `projects/${projectId}/locations/asia-southeast1/services/${deployment.serviceName}`;
  const secretEndpoints = (
    prefix: "primary" | "secondary",
    reference: { readonly name: string; readonly version: string },
  ): readonly GoogleControlPlaneReadRequest<ControllerControlPlaneReadbackKey>[] => {
    const keyPrefix = prefix === "primary" ? "primarySecret" : "secondarySecret";
    const secretResource = `projects/${projectId}/secrets/${reference.name}`;
    return [
      {
        key: keyPrefix,
        method: "GET",
        url: `https://secretmanager.googleapis.com/v1/${secretResource}`,
      },
      {
        key: `${keyPrefix}Version`,
        method: "GET",
        url: `https://secretmanager.googleapis.com/v1/${secretResource}/versions/${reference.version}`,
      },
      {
        key: `${keyPrefix}IamPolicy`,
        method: "GET",
        url: `https://secretmanager.googleapis.com/v1/${secretResource}:getIamPolicy?options.requestedPolicyVersion=3`,
      },
    ];
  };
  return [
    {
      key: "service",
      method: "GET",
      url: `https://run.googleapis.com/v2/${serviceResource}`,
    },
    {
      key: "serviceIamPolicy",
      method: "GET",
      url: `https://run.googleapis.com/v2/${serviceResource}:getIamPolicy?options.requestedPolicyVersion=3`,
    },
    ...secretEndpoints("primary", deployment.primaryHmacSecret),
    ...(deployment.secondaryHmacSecret === undefined
      ? []
      : secretEndpoints("secondary", deployment.secondaryHmacSecret)),
    {
      key: "binaryAuthorizationPolicy",
      method: "GET",
      url: `https://binaryauthorization.googleapis.com/v1/projects/${projectId}/policy`,
    },
  ];
}

export class GoogleControllerControlPlaneReadbackClient {
  readonly #reads: BoundedGoogleControlPlaneReadClient;

  constructor(tokens: AccessTokenProvider, controlPlaneFetch: typeof fetch = fetch) {
    this.#reads = new BoundedGoogleControlPlaneReadClient(tokens, controlPlaneFetch);
  }

  async readAndVerify(
    expectation: ControllerControlPlaneReadbackExpectation,
  ): Promise<ControllerControlPlaneReadbackEvidence> {
    const expected = controllerControlPlaneReadbackExpectationSchema.parse(expectation);
    const endpoints = createControllerControlPlaneReadbackRequests(expected);
    const second = await this.#reads.stableSnapshot(
      expected.deployment.manifest.projectId,
      endpoints,
    );
    const secondary = expected.deployment.secondaryHmacSecret;
    return verifyControllerControlPlaneReadback(expected, {
      binaryAuthorizationPolicy: requireSnapshotValue(second, "binaryAuthorizationPolicy"),
      primarySecret: {
        iamPolicy: requireSnapshotValue(second, "primarySecretIamPolicy"),
        secret: requireSnapshotValue(second, "primarySecret"),
        version: requireSnapshotValue(second, "primarySecretVersion"),
      },
      ...(secondary === undefined
        ? {}
        : {
            secondarySecret: {
              iamPolicy: requireSnapshotValue(second, "secondarySecretIamPolicy"),
              secret: requireSnapshotValue(second, "secondarySecret"),
              version: requireSnapshotValue(second, "secondarySecretVersion"),
            },
          }),
      service: requireSnapshotValue(second, "service"),
      serviceIamPolicy: requireSnapshotValue(second, "serviceIamPolicy"),
    });
  }
}
