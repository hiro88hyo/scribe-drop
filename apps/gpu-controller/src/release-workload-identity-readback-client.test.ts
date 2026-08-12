import { describe, expect, it } from "vitest";

import { defaultSyntheticAuthorizations } from "./control-store.js";
import { createReleaseWorkloadIdentityReadbackRequests } from "./release-workload-identity-readback-client.js";
import { createReleaseWorkloadIdentityPlan } from "./release-workload-identity.js";
import { createReleaseSupplyChainDeploymentPlan } from "./release-supply-chain.js";

function plan(): ReturnType<typeof createReleaseWorkloadIdentityPlan> {
  return createReleaseWorkloadIdentityPlan(
    createReleaseSupplyChainDeploymentPlan({
      deployment: {
        authorization: defaultSyntheticAuthorizations().staging,
        controllerImageDigest: `asia-southeast1-docker.pkg.dev/scribe-phase14/controller/runtime@sha256:${"b".repeat(64)}`,
        controllerServiceAccount: "gpu-controller@scribe-phase14.iam.gserviceaccount.com",
        firestore: { databaseId: "scribe-staging-controller", projectId: "scribe-phase14" },
        manifest: {
          environment: "staging",
          imageDigest: `asia-southeast1-docker.pkg.dev/scribe-phase14/worker/runtime@sha256:${"a".repeat(64)}`,
          orchestratorOrigin: "https://orchestrator.example.test/",
          projectId: "scribe-phase14",
          resultHost: "storage.example.test",
          runtimeServiceAccount: "gpu-runtime@scribe-phase14.iam.gserviceaccount.com",
          sourceHost: "storage.example.test",
        },
        primaryHmacSecret: { name: "scribe-drop-staging-controller-primary", version: "7" },
        serviceName: "scribe-drop-staging-gpu-controller",
      },
      projectNumber: "123456789012",
    }),
  );
}

describe("release workload identity read-back requests", () => {
  it("uses eight fixed IAM reads with user-managed-key filtering and no mutations", () => {
    const requests = createReleaseWorkloadIdentityReadbackRequests(plan());

    expect(requests).toHaveLength(8);
    expect(new Set(requests.map(({ key }) => key)).size).toBe(8);
    expect(requests.every(({ url }) => new URL(url).origin === "https://iam.googleapis.com")).toBe(
      true,
    );
    expect(requests.filter(({ method }) => method === "POST_GET_IAM_POLICY")).toHaveLength(2);
    expect(requests.filter(({ url }) => url.endsWith("/keys?keyTypes=USER_MANAGED"))).toHaveLength(
      2,
    );
    expect(requests.every(({ url }) => !url.includes(":setIamPolicy"))).toBe(true);
    expect(requests.every(({ url }) => !url.includes("iamcredentials.googleapis.com"))).toBe(true);
  });
});
